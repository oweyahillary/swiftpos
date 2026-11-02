/**
 * billingDetailsAdmin.ts — A612 phase 3: ZapTill's own billing details, set in the admin portal (Billing details).
 *
 * Owner, 2026-10-30: "You can use dummy information … but in the admin panel we can add the true ones later". The invoice
 * (lib/cloudPlanEmail.ts branchInvoiceEmailHtml) prints them; until they are saved it prints the sample (marked "Sample
 * details"). Stored in admin_settings 'billing_details' (lib/branchBilling.ts).
 *
 *   GET /api/admin/billing-details — { seller, prices, saved }. Any admin.
 *   PUT /api/admin/billing-details — { seller: { legalName, address, kraPin, phone, email, mpesaPaybill, mpesaTill,
 *       accountRef: 'invoice' | 'business' }, prices: { cloud, analytics, attendance, themes, package } } — monthly prices,
 *       KES. A Paybill or a Till is required. Super admin, audited ('billing.details').
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin, requireSuperAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { BILLING_DETAILS_KEY, cleanBillingDetails, readBillingDetails, forgetBillingDetails } from '../lib/branchBilling';

const router = safeRouter();

router.get('/', requireAdmin, async (_req, res) => {
  res.json(await readBillingDetails());
});

router.put('/', requireAdmin, requireSuperAdmin, async (req: any, res) => {
  const b = req.body ?? {};
  if (!b.seller || typeof b.seller !== 'object') { res.status(400).json({ error: 'The company details are needed.', code: 'BAD_SELLER' }); return; }
  const clean = cleanBillingDetails(b);
  if (!String(b.seller.legalName ?? '').trim() || !String(b.seller.address ?? '').trim()) {
    res.status(400).json({ error: 'Type ZapTill\'s legal name and address.', code: 'BAD_SELLER' }); return;
  }
  if (!clean.seller.mpesaPaybill && !clean.seller.mpesaTill) {
    res.status(400).json({ error: 'Type the M-Pesa Paybill (or the Buy Goods Till number) clients pay to.', code: 'BAD_PAYBILL' }); return;
  }
  const before = await readBillingDetails();
  const value = { seller: { ...clean.seller, sample: undefined }, prices: clean.prices };
  const { error } = await supabase.from('admin_settings')
    .upsert({ key: BILLING_DETAILS_KEY, value, updated_by: req.adminEmail ?? null, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) { sendError(res, error); return; }
  forgetBillingDetails();
  const { error: aErr } = await supabase.from('admin_audit_log').insert({
    admin_id: req.adminId, admin_email: req.adminEmail, action: 'billing.details', resource: 'billing',
    business_id: null, business_name: null, before_data: before.saved ? { seller: before.seller, prices: before.prices } : null,
    after_data: value, reason: null, ip_address: req.ip ?? null,
  });
  if (aErr) console.error('[billing] details audit not written:', aErr.message);
  res.json(await readBillingDetails());
});

export default router;
