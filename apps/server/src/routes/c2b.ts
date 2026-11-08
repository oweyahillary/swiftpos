/**
 * c2b.ts — A621: M-Pesa payment notifications (Safaricom C2B), /api/payments/c2b/*.
 *
 * Owner, 2026-11-02: "Some customers do not like giving out their number, they prefer paying to the till or paybill
 * directly; what the cashier gets is a notification of the payments done, then they match it to the bill." The cashier
 * always TAPS the payment — never matched by amount alone. Part of the online licence (premium), like the STK prompt.
 *
 * SAFARICOM (no sign-in — the branch's secret token in the path authenticates the call; only its hash is stored):
 *   POST /confirm/:token    a payment to the branch's number → kept once per M-Pesa code (Safaricom retries), the branch's
 *                           POSs rung (lib/liveHub.ts ringMpesaPayment). Always answered { ResultCode: 0, 'Accepted' } —
 *                           the money has moved whatever we do; an unknown token, a branch switched off or an unreadable
 *                           body is logged and nothing kept.
 *   POST /validate/:token   always accepted (we never refuse a customer's payment).
 * THE POS (its own session, or a person on the web POS — the right to sell, orders.create; the POS's branch):
 *   GET  /recent?amount=&ref=&since=   { offered, payments, stamp } — the branch's untaken payments of the last 30 minutes,
 *                           the best fit for this bill first (lib/c2b.ts sortForBill); { offered: false } when not
 *                           licensed or not switched on; { unchanged: true } when nothing moved since `since`.
 *   POST /claim   { trans_id, sale_ref }   the payment taken for this bill — the first POS wins, the second 409 TAKEN.
 *   POST /release { trans_id, sale_ref }   given back (the cashier changed their mind, or closed the payment screen).
 *   An order carrying the code as its M-Pesa reference marks the payment used (lib/c2bOrders.ts, from routes/orders.ts).
 * THE OWNER'S LIST (reports.payments, the branch picked — Reports › M-Pesa unmatched):
 *   GET  /unmatched?from=YYYY-MM-DD&to=YYYY-MM-DD   the days' payments no sale used (waiting, or held by a POS whose sale
 *                           has not arrived) — Kenyan days, at most 31; both absent: today.
 */
import type { Request, Response } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, branchScope, oneBranchOnly, NO_BRANCH } from '../middleware/rbac';
import { sendError } from '../lib/sendError';
import { businessRangeEAT, businessDateEAT } from '@zaptill/core/businessDay';
import { ringMpesaPayment } from '../lib/liveHub';
import {
  ACCEPTED, RECENT_MINUTES, amountParam, dayRange, hashC2bToken, holderOf, looksLikeToken, parseConfirmation,
  saleRefParam, sortForBill, transIdParam,
} from '../lib/c2b';
import {
  branchOfToken, claimPayment, keepPayment, readC2bSettings, releasePayment, unmatchedPayments, waitingPayments,
} from '../lib/c2bStore';
import { c2bChangedSince, noteC2bChange, sinceParam } from '../lib/c2bActivity';
import { c2bLicensed, NOT_LICENSED } from '../lib/c2bAccess';

const router = safeRouter();
const sells = requirePermission('orders.create');

// ── Safaricom ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The token's last 6 characters — enough to tell two branches apart in a log, never enough to call as one. */
const tokenTail = (t: string) => `…${String(t).slice(-6)}`;

router.post('/validate/:token', (_req, res) => {
  res.json(ACCEPTED);
});

router.post('/confirm/:token', async (req, res) => {
  const token = String(req.params.token);
  try {
    await receivePayment(token, req.body);
  } catch (e: any) {
    console.error(`[c2b] A621: a confirmation for token ${tokenTail(token)} failed — reconcile against the M-Pesa statement:`, e?.message ?? e);
  }
  res.json(ACCEPTED);
});

async function receivePayment(token: string, body: unknown): Promise<void> {
  if (!looksLikeToken(token)) { console.warn(`[c2b] A621: a confirmation with a malformed token (${tokenTail(token)}) — ignored`); return; }
  const branch = await branchOfToken(hashC2bToken(token));
  if (!branch) { console.warn(`[c2b] A621: a confirmation for an unknown token ${tokenTail(token)} — ignored`); return; }
  const payment = parseConfirmation(body);
  if (!payment) { console.warn(`[c2b] A621: an unreadable confirmation for branch ${branch.branch_id} — ignored`); return; }
  if (!branch.enabled) {
    console.warn(`[c2b] A621: payment ${payment.transId} (KES ${payment.amount}) for branch ${branch.branch_id}, whose notifications are off — not kept`);
    return;
  }
  const kept = await keepPayment(branch.business_id, branch.branch_id, payment);
  if (kept !== 'new') return;
  noteC2bChange(branch.branch_id);
  ringMpesaPayment(branch.business_id, branch.branch_id, { trans_id: payment.transId, amount: payment.amount, first_name: payment.firstName });
  console.log(`[c2b] A621: payment ${payment.transId} KES ${payment.amount} received for branch ${branch.branch_id}`);
}

// ── The POS ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The branch this POS sells at (a POS's own; a person's; the owner's picked branch), or null. */
function posBranch(req: Request): string | null {
  const b = req.branchId || branchScope(req);
  return b && b !== NO_BRANCH ? b : null;
}

/** Is the list offered at this branch: licensed, switched on and registered with Safaricom? */
async function offeredAt(businessId: string, branchId: string): Promise<boolean> {
  if (!(await c2bLicensed(businessId))) return false;
  const s = await readC2bSettings(businessId, branchId);
  return !!s?.enabled && !!s.token_hash;
}

router.get('/recent', requireAuth, sells, async (req, res) => {
  const branchId = posBranch(req);
  if (!branchId || !(await c2bLicensed(req.businessId))) { res.json({ offered: false, payments: [] }); return; }
  const since = sinceParam(req.query.since);
  if (since !== null && !c2bChangedSince(branchId, since)) { res.json({ offered: true, unchanged: true, stamp: since }); return; }
  // Stamped BEFORE the read: a payment arriving during it makes the next ask read again.
  const stamp = Date.now();
  if (!(await offeredAt(req.businessId, branchId))) { res.json({ offered: false, payments: [], stamp }); return; }
  try {
    const payments = await waitingPayments(req.businessId, branchId, new Date(stamp - RECENT_MINUTES * 60_000).toISOString());
    const billRef = typeof req.query.ref === 'string' ? req.query.ref.slice(0, 40) : null;
    res.json({ offered: true, payments: sortForBill(payments, amountParam(req.query.amount), billRef), stamp });
  } catch (e: any) {
    res.status(503).json({ error: `Could not read the M-Pesa payments right now (${e?.message ?? e}).` });
  }
});

/** The claim / release body, or the reason it is not one (answered). */
function claimInput(req: Request, res: Response): { branchId: string; transId: string; saleRef: string; holder: string } | null {
  const branchId = posBranch(req);
  const transId = transIdParam(req.body?.trans_id);
  const saleRef = saleRefParam(req.body?.sale_ref);
  const holder = holderOf(req);
  if (!branchId) { res.status(400).json({ error: 'This session has no branch.', code: 'NO_BRANCH' }); return null; }
  if (!transId || !saleRef || !holder) { res.status(400).json({ error: 'trans_id and sale_ref are required.', code: 'BAD_CLAIM' }); return null; }
  return { branchId, transId, saleRef, holder };
}

router.post('/claim', requireAuth, sells, async (req, res) => {
  const input = claimInput(req, res);
  if (!input) return;
  if (!(await c2bLicensed(req.businessId))) { res.status(403).json(NOT_LICENSED); return; }
  const r = await claimPayment(req.businessId, input.branchId, input.transId, input.holder, input.saleRef);
  if ('refusal' in r) { res.status(r.refusal.status).json({ error: r.refusal.error, code: r.refusal.code }); return; }
  noteC2bChange(input.branchId);
  res.json({ ok: true, payment: r.payment });
});

router.post('/release', requireAuth, sells, async (req, res) => {
  const input = claimInput(req, res);
  if (!input) return;
  const released = await releasePayment(req.businessId, input.branchId, input.transId, input.holder, input.saleRef);
  if (released) noteC2bChange(input.branchId);
  res.json({ ok: true, released });
});

// ── The owner's day list ─────────────────────────────────────────────────────────────────────────────────────────────

router.get('/unmatched', requireAuth, requirePermission('reports.payments'), async (req, res) => {
  if (oneBranchOnly(req, res)) return;
  const days = dayRange(req.query.from, req.query.to, businessDateEAT(new Date()));
  if (!days) { res.status(400).json({ error: 'Pick up to 31 days.', code: 'BAD_RANGE' }); return; }
  try {
    const payments = await unmatchedPayments(req.businessId, branchScope(req), businessRangeEAT(days.from, days.to));
    const total = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
    res.json({ ...days, payments, total, licensed: await c2bLicensed(req.businessId) });
  } catch (e: any) {
    sendError(res, e, { message: 'Could not read the M-Pesa payments' });
  }
});

export default router;
