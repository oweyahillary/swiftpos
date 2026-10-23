/**
 * cloudPlanAdmin.ts — A581: the client's cloud payment plan in the admin portal (client › Plan & billing › Cloud plan).
 *
 * Owner, 2026-10-23: "add payment plan option such that i can select month on month and always remind me on email about
 * expiry and also the client". Rules in lib/cloudPlan.ts; the paid-until is businesses.web_access_expires_at.
 *
 *   GET  /api/admin/clients/:businessId/cloud-plan           — the plan (or the defaults), where the client stands
 *        (paid-until, days left, grace, sync stopped?), the payments (newest first), the reminders sent. Any admin.
 *   PUT  /api/admin/clients/:businessId/cloud-plan           — { period, amount, custom_until?, notes? }: sets the plan
 *        (puts the client on it). Super admin.
 *   POST /api/admin/clients/:businessId/cloud-plan/payments  — { amount, method, reference, paid_at?, period?,
 *        paid_until? (custom), note? }: records a payment — paid-until moves on one period from the LATER of now and the
 *        current paid-until; web access is switched on; an unconverted cloud trial is marked converted; a paid invoice is
 *        raised; who / when / amount / reference audited (admin_audit_log 'cloud_plan.payment'). The lapse gate opens at
 *        once. Super admin (a money write, as A495's invoices).
 *
 * Payment DETECTION is manual for now (the admin records what the client paid; M-Pesa Daraja later) — nothing here takes
 * money, and a monthly plan does not renew by itself: each month needs a recorded payment, and the reminders say so.
 *
 * Mounted at /admin/clients before /admin (routes/index.ts): a path this router does not serve falls through.
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin, requireSuperAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { CLOUD_TRIAL_KEY, readTrial } from '../lib/cloudTrial';
import {
  CLOUD_MONTHLY_KES, PERIOD_LABEL, PLAN_PERIODS, PAYMENT_METHODS, isPeriod, defaultAmount, nextPaidUntil, cloudStanding,
  readCloudFacts, forgetStanding, type PlanPeriod, type CloudPlanRow,
} from '../lib/cloudPlan';

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

async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const { count } = await supabase.from('invoices').select('*', { count: 'exact', head: true }).like('invoice_number', `INV-${year}-%`);
  return `INV-${year}-${String((count ?? 0) + 1).padStart(4, '0')}`;
}

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
    standing: s ? {
      gated: s.gated, state: s.state, trial: s.trial, paid_until: s.paidUntil, sync_stops_at: s.syncStopsAt,
      days_left: s.daysLeft, sync_refused: s.syncRefused,
    } : null,
    payments: payments.data ?? [],
    reminders: reminders.data ?? [],
    defaults: {
      monthly: CLOUD_MONTHLY_KES,
      periods: PLAN_PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p], amount: defaultAmount(p) })),
      methods: PAYMENT_METHODS,
    },
  };
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
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'business_id' }).select().single();
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
  const ext = nextPaidUntil({ period, now, paidUntil: before, customUntil: isoOrNull(b.paid_until) ?? plan?.custom_until ?? null });
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
      custom_until: period === 'custom' ? ext.until : null, updated_by: req.adminEmail ?? null,
    }, { onConflict: 'business_id' });
    if (p.error) console.error('[cloud-plan] plan not saved with the first payment:', p.error.message);
  }
  const fl = await supabase.from('feature_flags').upsert({
    business_id: client.id, key: 'web_hosting', enabled: true,
    notes: `Cloud plan — paid until ${ext.until.slice(0, 10)} (A581)`, set_by: req.adminEmail ?? null, updated_at: new Date(now).toISOString(),
  }, { onConflict: 'business_id,key' });
  if (fl.error) console.error('[cloud-plan] web access not switched on:', fl.error.message);
  let trialConverted = false;
  try {
    const trial = await readTrial(client.id);
    if (trial && !trial.converted_at) {
      const t = await supabase.from('business_settings').update({ value: { ...trial, converted_at: new Date(now).toISOString() }, updated_at: new Date(now).toISOString() })
        .eq('business_id', client.id).eq('key', CLOUD_TRIAL_KEY);
      trialConverted = !t.error;
    }
  } catch (e) { console.error('[cloud-plan] trial not marked converted:', (e as Error)?.message); }
  let invoiceNumber: string | null = null;
  try {
    invoiceNumber = await nextInvoiceNumber();
    const inv = await supabase.from('invoices').insert({
      business_id: client.id, invoice_number: invoiceNumber, amount, currency: 'KES', status: 'paid',
      payment_method: method, payment_reference: reference, period_start: ext.from, period_end: ext.until, paid_at: paidAt,
    }).select('id').single();
    if (!inv.error && inv.data) await supabase.from('cloud_payments').update({ invoice_id: (inv.data as { id: string }).id }).eq('id', payment.id);
    else invoiceNumber = null;
  } catch { invoiceNumber = null; }

  forgetStanding(client.id);
  await audit(req, client, 'cloud_plan.payment', { paid_until: before },
    { amount, currency: 'KES', period, method, reference, paid_at: paidAt, paid_until: ext.until, from: ext.from, invoice_number: invoiceNumber, trial_converted: trialConverted },
    text(b.note, 500));
  res.status(201).json({ payment: { ...payment, paid_until_after: ext.until }, trial_converted: trialConverted, invoice_number: invoiceNumber, ...(await planView(client.id)) });
});

export default router;
