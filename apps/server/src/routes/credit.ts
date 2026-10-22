import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, branchScope, assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { actor } from '../lib/actor';
import { confirmerRows } from '../lib/confirmerLookup';
import { mayApprove, isOwnerRow } from '../lib/approver';
import { worksAtBranch } from '../lib/branchAccess';
import { CREDIT_STATES, cleanReason, creditCounts, decisionRefusal, decisionTime, listCreditSales, targetState, awaitingSentence,
  type CreditDecision, type CreditState } from '../lib/creditConfirm';   // A545

const router = safeRouter();
router.use(requireAuth);

// A494: the credit accounts (who owes what) and each account's ledger were open to every signed-in user. Reading them
// is customers.view — the key the manager's Credit tab and the web POS's "pay on account" check already hold (a
// cashier's role has it by default; the POS reads GET /customer/:id at payment for the available credit) — or
// customers.credit (who changes limits and takes repayments reads what they change). The ledger goes with the
// account: it is the history of the balance the same screen shows, and splitting it would hide nothing the balance
// does not already tell.
const canReadCredit = requireAnyPermission('customers.view', 'customers.credit');

// GET /api/credit/customers — list customers with a limit or an outstanding balance (debtors first)
router.get('/customers', canReadCredit, async (req, res) => {
  const { search } = req.query;
  let q = supabase
    .from('customers')
    .select('id, name, phone, email, credit_limit, credit_balance, status')
    .eq('business_id', req.businessId)
    .or('credit_limit.gt.0,credit_balance.gt.0')
    .order('credit_balance', { ascending: false })
    .limit(200);
  if (search) q = q.ilike('name', `%${search as string}%`);

  const { data, error } = await q;
  if (error) { sendError(res, error); return; }

  const rows = (data ?? []).map((c: any) => ({
    ...c,
    available_credit: Math.max(0, Number(c.credit_limit) - Number(c.credit_balance)),
  }));
  res.json(rows);
});

// GET /api/credit/customer/:id — one account + recent ledger
router.get('/customer/:id', canReadCredit, async (req, res) => {
  const { data: customer, error } = await supabase
    .from('customers')
    .select('id, name, phone, email, credit_limit, credit_balance, status')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (error || !customer) { res.status(404).json({ error: 'Customer not found' }); return; }

  const { data: ledger } = await supabase
    .from('customer_credit_transactions')
    .select('id, type, amount, balance_after, method, reference, notes, order_id, created_at')
    .eq('customer_id', req.params.id)
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .limit(100);

  // A545: a sale on account carries its manager's confirmation — a DISPUTED sale stays on the balance (owed until it is
  // voided or refunded) and is marked so on the statement. Before migration 157: nothing to mark.
  const marks = new Map<string, { state: CreditState; dispute_reason: string | null; decided_by_name: string | null }>();
  const orderIds = [...new Set((ledger ?? []).map((l: { order_id: string | null }) => l.order_id).filter((x): x is string => !!x))];
  if (orderIds.length) {
    const { data: cc } = await supabase.from('credit_confirmations').select('order_id, state, dispute_reason, decided_by_name')
      .eq('business_id', req.businessId).in('order_id', orderIds);
    for (const c of (cc ?? []) as Array<{ order_id: string; state: CreditState; dispute_reason: string | null; decided_by_name: string | null }>) marks.set(c.order_id, c);
  }

  res.json({
    customer: {
      ...customer,
      available_credit: Math.max(0, Number(customer.credit_limit) - Number(customer.credit_balance)),
    },
    ledger: (ledger ?? []).map((l: { order_id: string | null; type: string }) => {
      const m = l.order_id && l.type === 'charge' ? marks.get(l.order_id) : undefined;
      return m ? { ...l, confirm_state: m.state, dispute_reason: m.dispute_reason, decided_by_name: m.decided_by_name } : l;
    }),
  });
});

// GET /api/credit/candidates?search= — A567: the business's customers by name or phone, to give one their FIRST credit
// limit (Credit Accounts › "+ Give credit"). The list above only shows customers who already have a limit or a balance,
// so no screen could start an account. customers.credit — the key that sets the limit.
router.get('/candidates', requirePermission('customers.credit'), async (req, res) => {
  // PostgREST's or() is a comma/parenthesis grammar: those (and the LIKE wildcards) are taken out of what was typed.
  const term = String(req.query.search ?? '').replace(/[,()%*\\:"']/g, ' ').trim().slice(0, 60);
  let q = supabase
    .from('customers')
    .select('id, name, phone, email, credit_limit, credit_balance, status')
    .eq('business_id', req.businessId)
    .eq('status', 'active')
    .order('name', { ascending: true })
    .limit(20);
  if (term) q = q.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  res.json((data ?? []).map((c: any) => ({
    ...c,
    credit_limit: Number(c.credit_limit) || 0,
    credit_balance: Number(c.credit_balance) || 0,
    available_credit: Math.max(0, Number(c.credit_limit) - Number(c.credit_balance)),
  })));
});

// PATCH /api/credit/customer/:id/limit — set the credit limit
// A567: the limit is APPROVED by whoever sets it — customers.credit (the owner always, managers by default) — and who and
// when go in the business's audit log (audit_log: before and after). The till's credit-customer list
// (GET /api/pos/credit-customers) carries a customer once their limit is above 0, at its next pull.
router.patch('/customer/:id/limit', requirePermission('customers.credit'), async (req, res) => {
  // A567: a person approves a limit — a till's own session names nobody.
  if (req.isTill || !req.userId) { res.status(403).json({ error: 'A credit limit is set by a person, signed in.', code: 'PERSON_ONLY' }); return; }
  const limit = Number(req.body?.credit_limit);
  if (!Number.isFinite(limit) || limit < 0) {
    res.status(400).json({ error: 'credit_limit must be a non-negative number' });
    return;
  }

  const { data: before } = await supabase
    .from('customers')
    .select('id, credit_limit')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .maybeSingle();
  if (!before) { res.status(404).json({ error: 'Customer not found' }); return; }
  const from = Number((before as { credit_limit?: number }).credit_limit) || 0;

  const { data, error } = await supabase
    .from('customers')
    .update({ credit_limit: limit, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select('id, credit_limit, credit_balance')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Customer not found' }); return; }
  await auditLimit(req, req.params.id, from, limit);
  res.json(data);
});

/** A567: who approved a credit limit, and when (audit_log.created_at) — best-effort, never fails the change. */
async function auditLimit(req: any, customerId: string, from: number, to: number): Promise<void> {
  if (from === to) return;
  try {
    const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
    const { error } = await supabase.from('audit_log').insert({
      business_id: req.businessId, branch_id: null, user_id: req.userId ?? null, user_name: (me as any)?.name ?? null,
      action: from === 0 ? 'customer.credit_limit.granted' : 'customer.credit_limit.changed', table_name: 'customers',
      record_id: customerId, before_data: { credit_limit: from }, after_data: { credit_limit: to },
    });
    if (error) console.error('[credit] limit audit not written:', error.message);
  } catch (e) { console.error('[credit] limit audit not written:', (e as Error)?.message ?? e); }
}

// POST /api/credit/customer/:id/payment — record a repayment (decreases balance)
// Body: { amount, method, reference?, notes? }
router.post('/customer/:id/payment', requirePermission('customers.credit'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const { method, reference, notes } = req.body ?? {};
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'amount must be a positive number' });
    return;
  }

  const { data: balance, error } = await supabase.rpc('apply_credit_transaction', {
    p_business_id:   req.businessId,
    p_customer_id:   req.params.id,
    p_branch_id:     branchScope(req) ?? null,
    p_order_id:      null,
    p_type:          'payment',
    p_amount:        -Math.abs(amount),   // repayment decreases balance
    p_method:        method ?? null,
    p_reference:     reference ?? null,
    p_notes:         notes ?? null,
    p_created_by:    req.userId,
    p_enforce_limit: false,
  });

  if (error) {
    if (error.message?.includes('CUSTOMER_NOT_FOUND')) { res.status(404).json({ error: 'Customer not found' }); return; }
    sendError(res, error); return;
  }
  res.json({ credit_balance: balance });
});

// POST /api/credit/customer/:id/adjustment — manual correction (+/-) with a reason
// Body: { amount (signed), notes }
router.post('/customer/:id/adjustment', requirePermission('customers.credit'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const notes = (req.body?.notes ?? '').trim();
  if (!Number.isFinite(amount) || amount === 0) {
    res.status(400).json({ error: 'amount must be a non-zero number' });
    return;
  }
  if (!notes) { res.status(400).json({ error: 'A reason (notes) is required for an adjustment' }); return; }

  const { data: balance, error } = await supabase.rpc('apply_credit_transaction', {
    p_business_id:   req.businessId,
    p_customer_id:   req.params.id,
    p_branch_id:     branchScope(req) ?? null,
    p_order_id:      null,
    p_type:          'adjustment',
    p_amount:        amount,              // signed
    p_method:        null,
    p_reference:     null,
    p_notes:         notes,
    p_created_by:    req.userId,
    p_enforce_limit: false,               // adjustments bypass the limit by design
  });

  if (error) {
    if (error.message?.includes('CUSTOMER_NOT_FOUND')) { res.status(404).json({ error: 'Customer not found' }); return; }
    sendError(res, error); return;
  }
  res.json({ credit_balance: balance });
});

// ── A545: credit sales to confirm ─────────────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-21: "for credit I think the manager has to know which sale is on credit and they have to confirm that it
// was done." Every sale on account: awaiting → confirmed / disputed (lib/creditConfirm.ts). customers.credit (A511's key:
// managers by default, the owner always) — a manager their own branch, the owner every branch (or the one picked).
const creditKey = requirePermission('customers.credit');

// GET /api/credit/sales?state=open|awaiting|disputed|confirmed|all — the list (open = awaiting + disputed) and the counts.
router.get('/sales', creditKey, async (req, res) => {
  const asked = String(req.query.state ?? 'open');
  const states: CreditState[] = asked === 'all' ? [...CREDIT_STATES]
    : (CREDIT_STATES as readonly string[]).includes(asked) ? [asked as CreditState] : ['awaiting', 'disputed'];
  const branch = branchScope(req);
  const [rows, counts] = await Promise.all([
    listCreditSales(req.businessId!, branch, states, Number(req.query.limit) || 200),
    creditCounts(req.businessId!, branch),
  ]);
  res.json({ rows, counts, notice: awaitingSentence(counts.awaiting) });
});

// GET /api/credit/sales/count — the badge, and the Close Day / Close Branch notice (whoever closes the day reads it too).
// NEVER blocks a close (the owner: no deadlocks) — it only says how many wait.
router.get('/sales/count', requireAnyPermission('customers.credit', 'shifts.close_day', 'shifts.close_branch'), async (req, res) => {
  const counts = await creditCounts(req.businessId!, branchScope(req));
  res.json({ ...counts, notice: awaitingSentence(counts.awaiting) });
});

/**
 * POST /api/credit/sales/:orderId/confirm  { }            — "it was done"
 * POST /api/credit/sales/:orderId/dispute  { reason }     — "it was not right" (the sale stays owed until voided/refunded)
 *   A person's sign-in only (lib/terminalWrites MANAGER_WRITES), deciding as themselves (customers.credit; a manager their
 *   own branch; only the owner re-decides a decided sale).
 * POST /api/credit/sales/:orderId/replay   { decision, by, at, reason? }
 *   The till's OWN sign-in only (TILL_WRITES — as A365's /confirm beside A433's /manager-confirm): a decision a manager
 *   signed in on that till made while it was offline, naming who (`by`) and when (`at`). That person must hold
 *   customers.credit at the sale's branch and the sale must be the till's branch's; the till's token itself never holds
 *   customers.credit (no tillScope check is asked for). A replay never overturns a decided sale.
 */
const personGate = (req: any, res: any, next: any) => {
  if (req.isTill) { res.status(403).json({ error: "A till sends a manager's decision as a replay.", code: 'TILL_SENDS_REPLAY' }); return; }
  creditKey(req, res, next);
};
const tillGate = (req: any, res: any, next: any) => {
  if (req.isTill === true && !!req.deviceId) { next(); return; }
  res.status(403).json({ error: "Only a till sends a replay — decide with your own sign-in.", code: 'REPLAY_IS_THE_TILLS' });
};
const decide = (fixed?: CreditDecision) => async (req: any, res: any) => {
  const decision: CreditDecision = fixed ?? (req.body?.decision === 'dispute' ? 'dispute' : req.body?.decision === 'confirm' ? 'confirm' : (null as unknown as CreditDecision));
  const orderId = String(req.params.orderId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) { res.status(400).json({ error: 'Which sale?' }); return; }
  const { data: row, error } = await supabase.from('credit_confirmations').select('order_id, branch_id, state')
    .eq('order_id', orderId).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return; }
  const cur = row as { order_id: string; branch_id: string | null; state: CreditState } | null;
  if (cur && !req.isOwner && !assertBranchAccess(req, cur.branch_id)) {
    res.status(403).json({ error: "That sale is another branch's.", code: 'OTHER_BRANCH' }); return;
  }
  let decidedBy: string | null = null; let decidedName: string | null = null;
  if (req.isTill) {
    const { rows, ownerId } = await confirmerRows(req.businessId);
    const by = rows.find((r) => r.id === req.body?.by);
    if (!by || !mayApprove(by, ownerId, 'credit') || (cur?.branch_id && !isOwnerRow(by, ownerId) && !worksAtBranch(by.user_branches, cur.branch_id))) {
      res.status(403).json({ error: 'The person who decided this may not confirm sales on account.', code: 'NOT_A_CREDIT_APPROVER' }); return;
    }
    decidedBy = by.id; decidedName = by.name ?? null;
  } else {
    const who = await actor(req);
    decidedBy = who.id; decidedName = who.name;
  }
  const reason = cleanReason(req.body?.reason);
  const refusal = decisionRefusal(cur?.state ?? null, { decision, reason }, !!req.isOwner && !req.isTill);
  if (refusal) { res.status(refusal.status).json(refusal.body); return; }
  const target = targetState(decision);
  if (cur!.state === target) { res.json({ order_id: orderId, state: target, duplicate: true }); return; }   // a repeat
  const at = req.isTill ? decisionTime(req.body?.at) : new Date().toISOString();
  const { data: done, error: uErr } = await supabase.from('credit_confirmations')
    .update({ state: target, decided_by: decidedBy, decided_by_name: decidedName, decided_at: at,
      dispute_reason: decision === 'dispute' ? reason : null })
    .eq('order_id', orderId).eq('business_id', req.businessId).eq('state', cur!.state)
    .select('order_id, state, decided_by_name, decided_at, dispute_reason');
  if (uErr) { sendError(res, uErr); return; }
  if (!(done ?? []).length) { res.status(409).json({ error: 'Someone else decided it just now — refresh.', code: 'ALREADY_DECIDED' }); return; }
  console.log(`[credit] A545: sale ${orderId} ${target} by ${decidedName ?? decidedBy ?? '?'}${req.isTill ? ` (sent by till ${req.deviceId})` : ''}`);
  res.json((done as unknown[])[0]);
};
router.post('/sales/:orderId/confirm', personGate, decide('confirm'));
router.post('/sales/:orderId/dispute', personGate, decide('dispute'));
router.post('/sales/:orderId/replay', tillGate, decide());

export default router;
