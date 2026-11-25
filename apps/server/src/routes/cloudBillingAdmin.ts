/**
 * cloudBillingAdmin.ts — A626 Phase 1: the ZapTill-admin side of the cloud-billing Paybill (client › nothing; it is
 * ZapTill-global). Mounted at /admin/cloud-billing → /api/admin/cloud-billing. Super admin registers the one Paybill's
 * C2B callback with Safaricom and fires a sandbox test; any admin reads the state and the raw receipts feed.
 *
 * ZapTill's Daraja keys are env vars (lib/cloudBilling.zaptillDaraja); only the callback token's hash + the registration
 * state live in the DB (migration 195). Reuses lib/c2bDaraja.ts (register, simulate) and lib/c2b.ts (token helpers).
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin, requireSuperAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { newC2bToken, hashC2bToken } from '../lib/c2b';
import { registerC2bUrls, simulateC2bPayment } from '../lib/c2bDaraja';
import { zaptillDaraja, serverEnvironment, callbackBase, billingC2bUrls, normalizeBillRef } from '../lib/cloudBilling';
import { readBillingC2bSettings, writeBillingC2bSettings, recentReceipts, ensureBillingCode, setBillingCode, matchBillingCode, assignReceipt, walletOf, creditEntries } from '../lib/cloudBillingStore';
import { allocate } from '../lib/cloudBillingAllocate';

const router = safeRouter();
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const textOrNull = (v: unknown, max: number): string | null => { const s = typeof v === 'string' ? v.trim().slice(0, max) : ''; return s || null; };

async function audit(req: any, action: string, after: object): Promise<void> {
  try {
    await supabase.from('admin_audit_log').insert({
      admin_id: req.adminId, admin_email: req.adminEmail, action, resource: 'cloud_billing',
      business_id: null, business_name: 'ZapTill', before_data: null, after_data: after, reason: null, ip_address: req.ip ?? null,
    });
  } catch { /* audit must never fail the action */ }
}

// GET /settings — is it configured (env keys present), the server's Daraja environment, and the registration state (never
// the token). `table:false` → migration 195 has not run.
router.get('/settings', requireAdmin, async (_req, res) => {
  const cfg = zaptillDaraja();
  const { row, table } = await readBillingC2bSettings();
  res.json({
    configured: !!cfg,
    server_environment: serverEnvironment(),
    table,
    registered: row ? { at: row.registered_at, shortcode: row.registered_shortcode, environment: row.registered_environment, last_error: row.last_error } : null,
  });
});

// POST /register — mint a token, register ZapTill's Paybill's confirm/validate URLs with Safaricom, store only the hash on
// success (a refusal keeps the prior working registration). Super admin.
router.post('/register', requireAdmin, requireSuperAdmin, async (req, res) => {
  const cfg = zaptillDaraja();
  if (!cfg) { res.status(400).json({ error: 'ZapTill\'s Daraja keys are not set (ZAPTILL_MPESA_CONSUMER_KEY / _SECRET / _SHORTCODE).', code: 'NO_CREDS' }); return; }
  const env = serverEnvironment();
  const token = newC2bToken();
  const urls = billingC2bUrls(callbackBase(), token);
  if ('error' in urls) { res.status(422).json({ error: urls.error, code: 'BAD_CALLBACK_URL' }); return; }

  const r = await registerC2bUrls({ consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret }, env, { shortcode: cfg.shortcode, confirm: urls.confirm, validate: urls.validate });
  if ('error' in r) {
    await writeBillingC2bSettings({ last_error: r.error }, req.adminId ?? null);
    res.status(502).json({ error: r.error, code: 'REGISTER_REFUSED' });
    return;
  }
  const w = await writeBillingC2bSettings(
    { token_hash: hashC2bToken(token), registered_at: new Date().toISOString(), registered_shortcode: cfg.shortcode, registered_environment: env, last_error: null },
    req.adminId ?? null,
  );
  if (w) { res.status(w.missingTable ? 503 : 500).json({ error: w.missingTable ? 'The database update (migration 195) has not run yet.' : w.message, code: w.missingTable ? 'MIGRATION_NEEDED' : 'WRITE_FAILED' }); return; }
  await audit(req, 'cloud_billing.register', { shortcode: cfg.shortcode, environment: env });
  res.json({ ok: true, shortcode: cfg.shortcode, environment: env });
});

// POST /test-payment — a KES 1 (default) sandbox C2B payment from Safaricom's test number, so the pipe can be seen end to
// end. Sandbox only. Super admin.
router.post('/test-payment', requireAdmin, requireSuperAdmin, async (req, res) => {
  const cfg = zaptillDaraja();
  if (!cfg) { res.status(400).json({ error: 'ZapTill\'s Daraja keys are not set.', code: 'NO_CREDS' }); return; }
  const { row } = await readBillingC2bSettings();
  if (!row?.registered_shortcode || row.registered_environment !== 'sandbox') {
    res.status(409).json({ error: 'A sandbox test payment needs the Paybill registered in sandbox first.', code: 'NOT_SANDBOX' });
    return;
  }
  const amount = Math.min(Math.max(Math.round(Number(req.body?.amount) || 1), 1), 70_000);
  const billRef = textOrNull(req.body?.bill_ref, 40);
  const r = await simulateC2bPayment({ consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret, type: cfg.type }, { shortcode: row.registered_shortcode, amount, billRef });
  if ('error' in r) { res.status(502).json({ error: r.error, code: 'SIMULATE_REFUSED' }); return; }
  res.json({ ok: true, amount, bill_ref: billRef });
});

// GET /receipts?from=&to= — the raw receipts feed, newest first, with the matched client attached.
router.get('/receipts', requireAdmin, async (req, res) => {
  const rows = await recentReceipts(isoOrNull(req.query.from), isoOrNull(req.query.to));
  res.json({ receipts: rows });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /clients/:id/code — a client's billing code (the Paybill account number), generated from its name if it has none.
router.get('/clients/:id/code', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) { res.status(400).json({ error: 'bad client id' }); return; }
  const code = await ensureBillingCode(id);
  if (code === null) { res.status(404).json({ error: 'No such client' }); return; }
  res.json({ code });
});

// PUT /clients/:id/code — set a client's billing code. Super admin; a code another client holds is refused.
router.put('/clients/:id/code', requireAdmin, requireSuperAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) { res.status(400).json({ error: 'bad client id' }); return; }
  const r = await setBillingCode(id, String(req.body?.code ?? ''));
  if ('error' in r) { res.status(409).json({ error: r.error, code: 'CODE_IN_USE' }); return; }
  await audit(req, 'cloud_billing.code', { business_id: id, code: r.code });
  res.json({ code: r.code });
});

// POST /receipts/:id/assign — assign an unmatched receipt to the client whose account code is given (fix a typo). Super admin.
router.post('/receipts/:id/assign', requireAdmin, requireSuperAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) { res.status(400).json({ error: 'bad receipt id' }); return; }
  const businessId = await matchBillingCode(normalizeBillRef(String(req.body?.code ?? '')));
  if (!businessId) { res.status(404).json({ error: 'No client has that account code.', code: 'UNKNOWN_CODE' }); return; }
  const r = await assignReceipt(id, businessId);
  if ('error' in r) { res.status(400).json({ error: r.error }); return; }
  await audit(req, 'cloud_billing.assign', { receipt_id: id, business_id: businessId });
  res.json({ ok: true, business_id: businessId });
});

// GET /clients/:id/credit — the client's cloud credit balance + ledger.
router.get('/clients/:id/credit', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) { res.status(400).json({ error: 'bad client id' }); return; }
  res.json({ balance: await walletOf(id), currency: 'KES', entries: await creditEntries(id) });
});

// POST /clients/:id/credit/allocate — apply the wallet to the client's open invoices now (a held underpayment). Super admin.
router.post('/clients/:id/credit/allocate', requireAdmin, requireSuperAdmin, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) { res.status(400).json({ error: 'bad client id' }); return; }
  const r = await allocate(id, { amount: 0, reference: 'wallet', paidAt: new Date().toISOString(), receiptId: null, by: req.adminEmail ?? 'admin' });
  await audit(req, 'cloud_billing.allocate', { business_id: id, settled: r.settled, wallet: r.wallet });
  res.json({ ok: true, settled: r.settled, wallet: r.wallet });
});

export default router;
