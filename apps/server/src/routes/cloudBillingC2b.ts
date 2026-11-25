/**
 * cloudBillingC2b.ts — A626 Phase 1: the addresses Safaricom calls for ZapTill's cloud-billing Paybill.
 *
 * Mounted at /cloud-billing/c2b (routes/index.ts) → /api/cloud-billing/c2b/{confirm,validate}/:token. Distinct from A621's
 * /api/payments/c2b/... so the two C2B systems never collide. No sign-in — the secret token in the path is the proof (only
 * its SHA-256 is stored). Always answers { ResultCode: 0, Accepted } at once; the payment's money has already moved.
 *
 * Phase 1 records the payment raw (deduped on the M-Pesa code). Matching it to a client and allocating it is Phase 2.
 */
import { safeRouter } from '../middleware/asyncHandler';
import { ACCEPTED, looksLikeToken, hashC2bToken, parseConfirmation } from '../lib/c2b';
import { billingTokenMatches, keepReceipt, receiptByTransId, setReceiptStatus } from '../lib/cloudBillingStore';
import { allocate, emailBillingReceipt } from '../lib/cloudBillingAllocate';

const router = safeRouter();

async function receiveBillingPayment(token: string, body: unknown): Promise<void> {
  if (!looksLikeToken(token)) return;
  if (!(await billingTokenMatches(hashC2bToken(token)))) return;   // not our token — ignore (still answer Accepted)
  const payment = parseConfirmation(body);
  if (!payment) return;
  if ((await keepReceipt(payment)) !== 'new') return;   // once per M-Pesa code
  // A626 Phase 2b: a matched payment is applied to the client's bill at once — web access, the open invoice(s), a trial —
  // and the remainder goes to the wallet. An unmatched one is left for the admin to assign.
  const rc = await receiptByTransId(payment.transId);
  if (!rc?.business_id) return;
  const result = await allocate(rc.business_id, { amount: Number(rc.amount), reference: payment.transId, paidAt: new Date().toISOString(), receiptId: rc.id, by: 'cloud-billing' });
  await setReceiptStatus(rc.id, result.openedAccess ? 'allocated' : 'matched');
  void emailBillingReceipt(rc.business_id, Number(rc.amount), payment.transId, result);   // fire-and-forget: Safaricom must not wait on the email
}

// Safaricom's validation — accept everything (External Validation is a later application; A626 §5).
router.post('/validate/:token', async (_req, res) => { res.json(ACCEPTED); });

// Safaricom's confirmation — record the payment, then always answer Accepted (even if anything above threw).
router.post('/confirm/:token', async (req, res) => {
  try { await receiveBillingPayment(String(req.params.token), req.body); } catch { /* never let a failure change the answer */ }
  res.json(ACCEPTED);
});

export default router;
