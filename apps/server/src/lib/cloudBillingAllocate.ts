/**
 * cloudBillingAllocate.ts — A626 Phase 2b: apply a matched M-Pesa payment (and the client's wallet) to its cloud bill.
 *
 * A receipt's amount + the wallet settle the client's open cloud invoices OLDEST-FIRST, each in full; the remainder stays
 * in the wallet (an overpayment, or an underpayment that cannot yet cover an invoice). Settling an invoice marks it paid,
 * moves its branches' paid-until to the period end, turns web access on and converts a trial — the same opening a hand-
 * recorded branch payment does (routes/cloudPlanAdmin.ts), fed by the invoice instead of admin-chosen branches.
 *
 * Nothing is ever half-enabled: an invoice is settled only when the pot covers it in full.
 */
import { supabase } from './supabase';
import { openCloudInvoices } from './cloudPlan';
import { convertTrialIfAny } from './cloudTrial';
import { walletOf, addCredit, businessesWithCredit } from './cloudBillingStore';
import { receiptEmailHtml } from './cloudPlanEmail';
import { sendEmailChecked } from './mailer';
import { ownerEmailOf } from './ownerEmail';

/** Turn the web_hosting switch on for a client, as a cloud payment does (routes/cloudPlanAdmin.ts webAccessOn). */
async function webAccessOnFor(businessId: string): Promise<void> {
  const { error } = await supabase.from('feature_flags').upsert(
    { business_id: businessId, key: 'web_hosting', enabled: true, notes: 'Cloud billing: a payment settled an invoice (A626)', set_by: 'cloud-billing', updated_at: new Date().toISOString() },
    { onConflict: 'business_id,key' },
  );
  if (error) console.error('[cloud-billing] web access not switched on:', error.message);
}

/** Settle one open cloud invoice: mark it paid and move its branches' paid-until to the period end (only forward). Returns
 *  the period end on success, or null if someone else settled it first. */
async function settleInvoice(inv: { id: string; invoice_number: string; period_end: string | null }, reference: string, paidAt: string, now: number): Promise<string | null> {
  const { data: full } = await supabase.from('invoices').select('branch_ids, period_end').eq('id', inv.id).maybeSingle();
  const branchIds = ((full as { branch_ids: string[] | null } | null)?.branch_ids) ?? [];
  const periodEnd = ((full as { period_end: string | null } | null)?.period_end) ?? inv.period_end;
  const u = await supabase.from('invoices').update({ status: 'paid', payment_method: 'mpesa', payment_reference: reference, paid_at: paidAt })
    .eq('id', inv.id).eq('status', 'pending').select('id');
  if (u.error || !(u.data ?? []).length) return null;   // lost the race — already paid
  if (periodEnd) for (const bid of branchIds) {
    const { data: bp } = await supabase.from('branch_cloud_plans').select('paid_until').eq('branch_id', bid).maybeSingle();
    const cur = (bp as { paid_until: string | null } | null)?.paid_until ?? null;
    if (!cur || cur < periodEnd) await supabase.from('branch_cloud_plans').update({ paid_until: periodEnd, updated_at: new Date(now).toISOString() }).eq('branch_id', bid);
  }
  return periodEnd;
}

export interface AllocateResult { settled: string[]; wallet: number; openedAccess: boolean; latestPaidUntil: string | null }

/**
 * Apply `amount` of new money PLUS the client's wallet to its open cloud invoices, oldest-first, settling each the pot
 * covers in full; the remainder stays in the wallet. `amount` 0 drains the wallet alone (the admin's Allocate, or the
 * billing job after it raises an invoice).
 */
export async function allocate(businessId: string, opts: { amount: number; reference: string; paidAt: string; receiptId: string | null; by: string | null }, now = Date.now()): Promise<AllocateResult> {
  let pot = Math.round((await walletOf(businessId) + opts.amount) * 100) / 100;
  const invoices = await openCloudInvoices(businessId);   // oldest first
  const settled: Array<{ number: string; amount: number }> = [];
  let latestPaidUntil: string | null = null;
  for (const inv of invoices) {
    const due = Number(inv.amount);
    if (!Number.isFinite(due) || due <= 0) continue;
    if (pot + 1e-9 < due) break;   // oldest-first: stop at the first it cannot cover in full (nothing half-paid)
    const periodEnd = await settleInvoice(inv, opts.reference, opts.paidAt, now);
    if (periodEnd === null) continue;
    pot = Math.round((pot - due) * 100) / 100;
    settled.push({ number: inv.invoice_number, amount: due });
    if (periodEnd && (!latestPaidUntil || periodEnd > latestPaidUntil)) latestPaidUntil = periodEnd;
  }

  // the ledger: the money in, then each settlement out — the balance ends at `pot`.
  if (opts.amount > 0) await addCredit(businessId, opts.amount, opts.reference ? `M-Pesa ${opts.reference}` : 'Payment', opts.receiptId, opts.by);
  for (const s of settled) await addCredit(businessId, -s.amount, `Paid ${s.number}`, opts.receiptId, opts.by);

  if (settled.length) {
    await webAccessOnFor(businessId);
    await convertTrialIfAny(businessId, now).catch(() => null);
    if (latestPaidUntil) {
      const { data: b } = await supabase.from('businesses').select('web_access_expires_at').eq('id', businessId).maybeSingle();
      const current = (b as { web_access_expires_at: string | null } | null)?.web_access_expires_at ?? null;
      if (!current || latestPaidUntil > current) await supabase.from('businesses').update({ web_access_expires_at: latestPaidUntil }).eq('id', businessId);
    }
  }
  return { settled: settled.map((s) => s.number), wallet: pot, openedAccess: settled.length > 0, latestPaidUntil };
}

/** Email the client a receipt: a paid-invoice receipt when something was settled, else a "credit received" note. */
export async function emailBillingReceipt(businessId: string, amount: number, reference: string, result: AllocateResult): Promise<boolean> {
  try {
    const { data: bz } = await supabase.from('businesses').select('owner_id, email, name').eq('id', businessId).maybeSingle();
    const b = bz as { owner_id?: string | null; email?: string | null; name?: string | null } | null;
    const to = await ownerEmailOf(b?.owner_id ?? null, b?.email ?? null);
    if (!to) return false;
    const name = b?.name ?? 'your business';
    if (result.settled.length) {
      const m = receiptEmailHtml({ businessName: name, amount, currency: 'KES', method: 'mpesa', reference, paidAt: new Date().toISOString(), paidUntil: result.latestPaidUntil, invoiceNumber: result.settled[0] });
      return (await sendEmailChecked({ to, subject: m.subject, html: m.html })).ok;
    }
    const html = `<p>Hi ${name},</p><p>We have received your payment of KES ${amount.toLocaleString('en-KE')} (M-Pesa ${reference}). It is held as ZapTill account credit (KES ${result.wallet.toLocaleString('en-KE')}) and applies to your next invoice automatically.</p><p>— ZapTill</p>`;
    return (await sendEmailChecked({ to, subject: 'ZapTill — payment received (credit)', html })).ok;
  } catch (e) { console.warn('[cloud-billing] receipt email not sent:', (e as Error)?.message); return false; }
}

/**
 * A626 Phase 2b: after the billing job raises invoices, apply every client's held credit to its open invoices — a
 * prepayment (or a topped-up underpayment) settles the new invoice by itself. A no-op when the credit cannot cover one;
 * only clients with a credit balance are touched.
 */
export async function drainCredits(now = Date.now()): Promise<{ drained: string[] }> {
  const drained: string[] = [];
  for (const businessId of await businessesWithCredit()) {
    try {
      const r = await allocate(businessId, { amount: 0, reference: 'wallet', paidAt: new Date(now).toISOString(), receiptId: null, by: 'auto (billing)' }, now);
      if (r.settled.length) drained.push(businessId);
    } catch (e) { console.error(`[cloud-billing] auto-drain failed for ${businessId}:`, (e as Error)?.message); }
  }
  return { drained };
}
