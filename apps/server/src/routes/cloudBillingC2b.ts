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
import { billingTokenMatches, keepReceipt } from '../lib/cloudBillingStore';

const router = safeRouter();

async function receiveBillingPayment(token: string, body: unknown): Promise<void> {
  if (!looksLikeToken(token)) return;
  if (!(await billingTokenMatches(hashC2bToken(token)))) return;   // not our token — ignore (still answer Accepted)
  const payment = parseConfirmation(body);
  if (!payment) return;
  await keepReceipt(payment);   // once per M-Pesa code
}

// Safaricom's validation — accept everything (External Validation is a later application; A626 §5).
router.post('/validate/:token', async (_req, res) => { res.json(ACCEPTED); });

// Safaricom's confirmation — record the payment, then always answer Accepted (even if anything above threw).
router.post('/confirm/:token', async (req, res) => {
  try { await receiveBillingPayment(String(req.params.token), req.body); } catch { /* never let a failure change the answer */ }
  res.json(ACCEPTED);
});

export default router;
