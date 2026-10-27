import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, branchScope, assertBranchAccess, branchFilter } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { actor } from '../lib/actor';
import { confirmerRows } from '../lib/confirmerLookup';
import { mayApprove, isOwnerRow } from '../lib/approver';
import { worksAtBranch } from '../lib/branchAccess';
import { CREDIT_STATES, cleanReason, creditCounts, decisionRefusal, decisionTime, listCreditSales, targetState, awaitingSentence,
  type CreditDecision, type CreditState } from '../lib/creditConfirm';   // A545
import { ownerOnlyGate, limitSetterGate, OWNER_CHOOSES_APPROVERS, CREDIT_APPROVERS_KEY, cleanRule, loadCreditRule,
  mayDecideCreditSale, CHOSEN_APPROVERS_DECIDE } from '../lib/creditApprovers';   // A585, A587
import { creditHistory } from '../lib/creditHistory';   // A585
import { isTheOwner } from '../lib/creditApprovers';   // A595 D4
import { loadCreditSettings, limitRefusal, partnerDecidesAt, auditCredit, readMaxLimit, CREDIT_MAX_KEY, PARTNER_CREDIT_KEY,
  BRANCH_CREDIT_KEY, branchCreditOn } from '../lib/branchCredit';   // A595 D4
import { maskCustomerContacts, seesCustomerContacts, customerSearchFilter } from '../lib/personalData';   // A595

const router = safeRouter();
router.use(requireAuth);
// A595 (docs/PERMISSIONS-AUDIT.md F1): customers' phone numbers and e-mails masked in every answer here unless the caller
// holds customers.contacts (lib/personalData.ts).
router.use(maskCustomerContacts());
const likeLiteral = (v: string): string => v.replace(/[\\%_]/g, (c) => '\\' + c);

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
  if (search) q = q.ilike('name', `%${likeLiteral(String(search))}%`);   // A595: the search is literal

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
    .select('id, type, amount, balance_after, method, reference, notes, order_id, created_at, branch_id')
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

  // A595 D4: what they owe at each branch and the limit there (if one is set), and whether the owner locked the limit.
  const owedBy = new Map<string, number>();
  const { data: allLines } = await supabase.from('customer_credit_transactions').select('branch_id, amount')
    .eq('customer_id', req.params.id).eq('business_id', req.businessId).limit(10000);
  for (const l of (allLines ?? []) as Array<{ branch_id?: string | null; amount?: unknown }>) if (l.branch_id) owedBy.set(l.branch_id, (owedBy.get(l.branch_id) ?? 0) + (Number(l.amount) || 0));
  const { data: bl } = await supabase.from('customer_branch_credit_limits').select('branch_id, credit_limit, set_by_name, set_at')
    .eq('business_id', req.businessId).eq('customer_id', req.params.id);
  const { data: lk } = await supabase.from('customers').select('credit_limit_locked').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  const branchIds = [...new Set([...owedBy.keys(), ...((bl ?? []) as Array<{ branch_id: string }>).map((b) => b.branch_id)])];
  const { data: bn } = branchIds.length ? await supabase.from('branches').select('id, name').eq('business_id', req.businessId).in('id', branchIds) : { data: [] as any[] };
  const nameOf = new Map(((bn ?? []) as Array<{ id: string; name: string | null }>).map((b) => [b.id, b.name]));
  const limitOf = new Map(((bl ?? []) as Array<{ branch_id: string; credit_limit: unknown; set_by_name: string | null; set_at: string }>).map((b) => [b.branch_id, b]));
  const branches = branchIds.map((id) => ({ branch_id: id, branch_name: nameOf.get(id) ?? null,
    owed: Math.round((owedBy.get(id) ?? 0) * 100) / 100,
    credit_limit: limitOf.has(id) ? Number(limitOf.get(id)!.credit_limit) : null,
    set_by_name: limitOf.get(id)?.set_by_name ?? null, set_at: limitOf.get(id)?.set_at ?? null }));
  const here = typeof req.branchId === 'string' ? branches.find((b) => b.branch_id === req.branchId) : undefined;
  res.json({
    customer: {
      ...customer,
      // A595 D4: at the branch the caller works at, a limit set there decides what is left (owed here); else the business's.
      available_credit: Math.max(0, here && here.credit_limit !== null ? here.credit_limit - here.owed : Number(customer.credit_limit) - Number(customer.credit_balance)),
      ...(here ? { owed_here: here.owed, branch_limit: here.credit_limit } : {}),
      credit_limit_locked: (lk as { credit_limit_locked?: boolean } | null)?.credit_limit_locked === true,
    },
    branches,
    ledger: (ledger ?? []).map((l: { order_id: string | null; type: string }) => {
      const m = l.order_id && l.type === 'charge' ? marks.get(l.order_id) : undefined;
      return m ? { ...l, confirm_state: m.state, dispute_reason: m.dispute_reason, decided_by_name: m.decided_by_name } : l;
    }),
  });
});

// GET /api/credit/candidates?search= — A567: the business's customers by name or phone, to give one their FIRST credit
// limit (Credit Accounts › "+ Give credit"). The list above only shows customers who already have a limit or a balance,
// so no screen could start an account. A585: whoever may set a limit — the owner or the built-in Manager role (was customers.credit).
router.get('/candidates', limitSetterGate(), async (req, res) => {
  // PostgREST's or() is a comma/parenthesis grammar: those (and the LIKE wildcards) are taken out of what was typed.
  const term = String(req.query.search ?? '').replace(/[,()%*\\:"']/g, ' ').trim().slice(0, 60);
  let q = supabase
    .from('customers')
    .select('id, name, phone, email, credit_limit, credit_balance, status')
    .eq('business_id', req.businessId)
    .eq('status', 'active')
    .order('name', { ascending: true })
    .limit(20);
  // A595: one quoted literal per value; without customers.contacts a phone matches only when typed in full.
  const filter = customerSearchFilter(term, seesCustomerContacts(req));
  if (filter) q = q.or(filter);
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
// A585 (owner, 2026-10-23: "credit limit — the owner for now; they can assign to branch manager for approval but they set
// the limit"), then the owner change the same day ("add the credit rights to the manager"): giving, changing or removing a
// limit is the OWNER's or the built-in MANAGER role's (lib/creditApprovers.ts maySetCreditLimits) — never a supervisor,
// General / Finance Manager, a custom role named Manager, a partner, someone holding the owner's role by PIN, a till or
// ZapTill. Customers are business-wide: a manager may set any customer's limit; who and the branch they acted at are audited.
// A587 (owner, 2026-10-24): the built-in General Manager role too, and a partner acting at ONE of their branches on the
// dashboard (never "All my branches" — 403 PICK_ONE_BRANCH); customers stay business-wide, the partner's branch is audited.
router.patch('/customer/:id/limit', limitSetterGate(), async (req, res) => {
  // A567: a person approves a limit — a till's own session names nobody.
  if (req.isTill || !req.userId) { res.status(403).json({ error: 'A credit limit is set by a person, signed in.', code: 'PERSON_ONLY' }); return; }
  const limit = Number(req.body?.credit_limit);
  if (!Number.isFinite(limit) || limit < 0) {
    res.status(400).json({ error: 'credit_limit must be a non-negative number' });
    return;
  }

  // A595 D4: the lock (before migration 178 there is none: read without it).
  let { data: before, error: bErr } = await supabase
    .from('customers')
    .select('id, credit_limit, credit_limit_locked')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .maybeSingle();
  if (bErr && /credit_limit_locked/.test(String(bErr.message ?? ''))) {
    ({ data: before } = await supabase.from('customers').select('id, credit_limit').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle() as any);
  }
  if (!before) { res.status(404).json({ error: 'Customer not found' }); return; }
  const from = Number((before as { credit_limit?: number }).credit_limit) || 0;
  const wasLocked = (before as { credit_limit_locked?: boolean }).credit_limit_locked === true;

  // A595 D4 (owner, 2026-10-27): the owner's ceiling and lock — anyone but the owner is refused above the ceiling, and on a
  // limit the owner locked. Only the owner locks or unlocks (`locked`).
  const owner = await isTheOwner(req);
  const settings = await loadCreditSettings(req.businessId!);
  const refusal = limitRefusal({ owner, amount: limit, max: settings.maxLimit, locked: wasLocked });
  if (refusal) { res.status(403).json(refusal); return; }
  const lockAsked = typeof req.body?.locked === 'boolean' ? req.body.locked as boolean : undefined;
  if (lockAsked !== undefined && !owner) { res.status(403).json({ error: 'Only the owner locks a credit limit.', code: 'OWNER_LOCKS' }); return; }
  const lockFields = lockAsked === undefined ? {}
    : lockAsked ? { credit_limit_locked: true, credit_limit_locked_by: req.userId ?? null, credit_limit_locked_at: new Date().toISOString() }
    : { credit_limit_locked: false, credit_limit_locked_by: null, credit_limit_locked_at: null };

  const { data, error } = await supabase
    .from('customers')
    .update({ credit_limit: limit, ...lockFields, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select('id, credit_limit, credit_balance')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Customer not found' }); return; }
  await auditLimit(req, req.params.id, from, limit);
  if (lockAsked !== undefined && lockAsked !== wasLocked) {
    await auditCredit(req, lockAsked ? 'customer.credit_limit.locked' : 'customer.credit_limit.unlocked', req.params.id,
      { locked: wasLocked }, { locked: lockAsked, credit_limit: limit });
  }
  res.json(data);
});

/** A567: who approved a credit limit, and when (audit_log.created_at) — best-effort, never fails the change. */
async function auditLimit(req: any, customerId: string, from: number, to: number): Promise<void> {
  if (from === to) return;
  try {
    const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
    // A585: the branch the person acted at (a manager's PIN sign-in; A587: a partner's picked branch), when it is this business's — else none.
    let branchId: string | null = null;
    if (typeof req.branchId === 'string' && /^[0-9a-f-]{36}$/i.test(req.branchId)) {
      const { data: br } = await supabase.from('branches').select('id').eq('id', req.branchId).eq('business_id', req.businessId).maybeSingle();
      branchId = (br as { id?: string } | null)?.id ?? null;
    }
    const { error } = await supabase.from('audit_log').insert({
      business_id: req.businessId, branch_id: branchId, user_id: req.userId ?? null, user_name: (me as any)?.name ?? (req.isOwner ? 'Owner' : null),   // A585: the owner with no users row is named
      action: from === 0 ? 'customer.credit_limit.granted' : to === 0 ? 'customer.credit_limit.removed' : 'customer.credit_limit.changed',   // A585: .removed
      table_name: 'customers',
      record_id: customerId, before_data: { credit_limit: from }, after_data: { credit_limit: to },
    });
    if (error) console.error('[credit] limit audit not written:', error.message);
  } catch (e) { console.error('[credit] limit audit not written:', (e as Error)?.message ?? e); }
}

// GET /api/credit/customer/:id/history — A585: the Credit history panel on the customer's profile: every limit grant /
// change / removal (who, when, old → new) and their recent sales on account with who sold and who APPROVED each.
// Read like the account itself (customers.view or customers.credit).
router.get('/customer/:id/history', canReadCredit, async (req, res) => {
  const id = String(req.params.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: 'Which customer?' }); return; }
  const { data: c, error } = await supabase.from('customers').select('id').eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return; }
  if (!c) { res.status(404).json({ error: 'Customer not found' }); return; }
  res.json(await creditHistory(req.businessId!, id, Number(req.query.limit) || 50));
});

// ── A595 D4: the owner's ceiling, the partners' switch, credit per branch, a customer's limit at a branch ─────────────
// GET  /api/credit/settings                     { max_limit, partners_decide, branches: [{ id, name, credit_enabled }] }
// PUT  /api/credit/settings { max_limit?, partners_decide? }          the owner only
// PUT  /api/credit/branches/:branchId { enabled }                      the owner; a partner at their own branch when allowed
// PUT  /api/credit/customer/:id/branch-limit { branch_id, credit_limit|null }   the owner; a partner at their own branch
const mayReadCreditSettings = (req: any): boolean => req.isOwner === true || req.webPartner === true
  || ['customers.view', 'customers.credit', 'customers.credit_limit'].some((k) => (req.permissionKeys ?? []).includes(k));
/** A595 D4: a business setting written (one row per business and key). Returns an error message, or null. */
async function upsertBusinessSetting(businessId: string, key: string, value: unknown): Promise<string | null> {
  const { data: existing, error: rErr } = await supabase.from('business_settings').select('id').eq('business_id', businessId).eq('key', key).maybeSingle();
  if (rErr) return rErr.message;
  const now = new Date().toISOString();
  const { error } = existing
    ? await supabase.from('business_settings').update({ value, updated_at: now }).eq('id', (existing as { id: string }).id)
    : await supabase.from('business_settings').insert({ business_id: businessId, key, value, updated_at: now });
  return error ? error.message : null;
}
/** A595 D4: a branch setting written (one row per branch and key). */
async function upsertBranchSetting(businessId: string, branchId: string, key: string, value: string): Promise<string | null> {
  const { data: existing, error: rErr } = await supabase.from('branch_settings').select('id').eq('business_id', businessId)
    .eq('branch_id', branchId).eq('key', key).maybeSingle();
  if (rErr) return rErr.message;
  const { error } = existing
    ? await supabase.from('branch_settings').update({ value }).eq('id', (existing as { id: string }).id)
    : await supabase.from('branch_settings').insert({ business_id: businessId, branch_id: branchId, key, value });
  return error ? error.message : null;
}
router.get('/settings', async (req, res) => {
  if (!mayReadCreditSettings(req)) { res.status(403).json({ error: 'Forbidden', detail: 'Missing permission: customers.view' }); return; }
  try {
    const settings = await loadCreditSettings(req.businessId!);
    const [{ data: branches }, { data: sw }] = await Promise.all([
      supabase.from('branches').select('id, name').eq('business_id', req.businessId).order('name', { ascending: true }),
      supabase.from('branch_settings').select('branch_id, value').eq('business_id', req.businessId).eq('key', BRANCH_CREDIT_KEY),
    ]);
    const on = new Map(((sw ?? []) as Array<{ branch_id: string; value: unknown }>).map((r) => [r.branch_id, branchCreditOn(r.value)]));
    res.json({ max_limit: settings.maxLimit, partners_decide: settings.partnersDecide, is_owner: await isTheOwner(req),
      branches: ((branches ?? []) as Array<{ id: string; name: string | null }>).map((b) => ({ id: b.id, name: b.name, credit_enabled: on.get(b.id) ?? true })) });
  } catch (e: any) { sendError(res, e); }
});
router.put('/settings', async (req, res) => {
  if (!(await isTheOwner(req))) { res.status(403).json({ error: 'Only the owner sets the credit maximum and who decides credit at a branch.', code: 'OWNER_ONLY' }); return; }
  const before = await loadCreditSettings(req.businessId!);
  if (req.body?.max_limit !== undefined) {
    const raw = req.body.max_limit;
    const max = raw === null || raw === '' ? null : readMaxLimit(raw);
    if (raw !== null && raw !== '' && max === null) { res.status(400).json({ error: 'The credit maximum is an amount above 0 (or none).' }); return; }
    const e = await upsertBusinessSetting(req.businessId!, CREDIT_MAX_KEY, max);
    if (e) { res.status(500).json({ error: e }); return; }
  }
  if (typeof req.body?.partners_decide === 'boolean') {
    const e = await upsertBusinessSetting(req.businessId!, PARTNER_CREDIT_KEY, req.body.partners_decide);
    if (e) { res.status(500).json({ error: e }); return; }
  }
  const after = await loadCreditSettings(req.businessId!);
  await auditCredit(req, 'credit.settings.changed', null, before, after);
  res.json({ max_limit: after.maxLimit, partners_decide: after.partnersDecide });
});
router.put('/branches/:branchId', async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'Say whether the branch sells on account (enabled: true or false).' }); return; }
  const branchId = String(req.params.branchId);
  const { data: br } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!br) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!(await isTheOwner(req))) {
    const no = partnerDecidesAt(req, await loadCreditSettings(req.businessId!), branchId);
    if (no) { res.status(403).json(no); return; }
  }
  const { data: was } = await supabase.from('branch_settings').select('value').eq('business_id', req.businessId).eq('branch_id', branchId).eq('key', BRANCH_CREDIT_KEY).maybeSingle();
  const e = await upsertBranchSetting(req.businessId!, branchId, BRANCH_CREDIT_KEY, req.body.enabled ? 'true' : 'false');
  if (e) { res.status(500).json({ error: e }); return; }
  await auditCredit(req, req.body.enabled ? 'branch.credit.enabled' : 'branch.credit.disabled', null,
    { credit_enabled: branchCreditOn((was as { value?: unknown } | null)?.value ?? null) }, { credit_enabled: req.body.enabled }, branchId);
  res.json({ branch_id: branchId, credit_enabled: req.body.enabled });
});
router.put('/customer/:id/branch-limit', async (req, res) => {
  if (req.isTill || !req.userId) { res.status(403).json({ error: 'A credit limit is set by a person, signed in.', code: 'PERSON_ONLY' }); return; }
  const branchId = typeof req.body?.branch_id === 'string' ? req.body.branch_id : '';
  const raw = req.body?.credit_limit;
  const limit = raw === null ? null : Number(raw);
  if (!branchId) { res.status(400).json({ error: 'Which branch?' }); return; }
  if (limit !== null && (!Number.isFinite(limit) || limit < 0)) { res.status(400).json({ error: 'credit_limit must be a non-negative number, or null to remove it' }); return; }
  const [{ data: br }, { data: cust }] = await Promise.all([
    supabase.from('branches').select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle(),
    supabase.from('customers').select('id, credit_limit_locked').eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle(),
  ]);
  if (!br) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!cust) { res.status(404).json({ error: 'Customer not found' }); return; }
  const owner = await isTheOwner(req);
  const settings = await loadCreditSettings(req.businessId!);
  if (!owner) {
    const no = partnerDecidesAt(req, settings, branchId);
    if (no) { res.status(403).json(no); return; }
  }
  const refusal = limitRefusal({ owner, amount: limit ?? 0, max: settings.maxLimit, locked: (cust as { credit_limit_locked?: boolean }).credit_limit_locked === true });
  if (refusal) { res.status(403).json(refusal); return; }
  const { data: was } = await supabase.from('customer_branch_credit_limits').select('id, credit_limit')
    .eq('business_id', req.businessId).eq('customer_id', req.params.id).eq('branch_id', branchId).maybeSingle();
  const from = was ? Number((was as { credit_limit?: unknown }).credit_limit) || 0 : null;
  const { data: me } = await supabase.from('users').select('name').eq('id', req.userId).maybeSingle();
  const row = { business_id: req.businessId, customer_id: req.params.id, branch_id: branchId, credit_limit: limit,
    set_by: req.userId, set_by_name: (me as { name?: string } | null)?.name ?? null, set_at: new Date().toISOString() };
  const { error } = limit === null
    ? await supabase.from('customer_branch_credit_limits').delete().eq('business_id', req.businessId).eq('customer_id', req.params.id).eq('branch_id', branchId)
    : was ? await supabase.from('customer_branch_credit_limits').update(row).eq('id', (was as { id: string }).id)
    : await supabase.from('customer_branch_credit_limits').insert(row);
  if (error) { sendError(res, error); return; }
  await auditCredit(req, limit === null ? 'customer.branch_credit_limit.removed' : 'customer.branch_credit_limit.set', req.params.id,
    { credit_limit: from }, { credit_limit: limit }, branchId);
  res.json({ customer_id: req.params.id, branch_id: branchId, credit_limit: limit });
});

// ── A585: who approves credit sales (the owner chooses, per branch) ─────────────────────────────────────────────────
// GET  /api/credit/approvers → { rule: { on, branches: { <branch>: [ids] } }, branches: [{id, name}], staff: [{id, name,
//      role, branch_ids}] } — the owner's setting and who may be picked.
// PUT  /api/credit/approvers { on, branches } — the owner only; each person must be active and work at that branch.
const ownerChooses = ownerOnlyGate(OWNER_CHOOSES_APPROVERS);
async function approverChoices(businessId: string) {
  const [{ data: br, error: bErr }, { data: st, error: sErr }] = await Promise.all([
    supabase.from('branches').select('id, name').eq('business_id', businessId).order('name', { ascending: true }),
    supabase.from('users').select('id, name, status, roles ( name ), user_branches ( branch_id )').eq('business_id', businessId).eq('status', 'active'),
  ]);
  if (bErr) throw bErr;
  if (sErr) throw sErr;
  return { branches: (br ?? []) as Array<{ id: string; name: string | null }>, staff: (st ?? []) as any[] };
}
router.get('/approvers', ownerChooses, async (req, res) => {
  try {
    const [rule, { branches, staff }] = await Promise.all([loadCreditRule(req.businessId), approverChoices(req.businessId!)]);
    res.json({
      rule, branches,
      staff: staff.map((s) => ({ id: s.id, name: s.name ?? '', role: s.roles?.name ?? null,
        branch_ids: (s.user_branches ?? []).map((b: { branch_id: string | null }) => b.branch_id).filter(Boolean) })),
    });
  } catch (e: any) { sendError(res, e); }
});
router.put('/approvers', ownerChooses, async (req, res) => {
  let choices;
  try { choices = await approverChoices(req.businessId!); } catch (e: any) { sendError(res, e); return; }
  const r = cleanRule(req.body, { branchIds: choices.branches.map((b) => b.id), staff: choices.staff });
  if (r.ok === false) { res.status(400).json({ error: r.error, code: 'BAD_APPROVERS' }); return; }
  const before = await loadCreditRule(req.businessId);
  const nowIso = new Date().toISOString();
  const { data: existing, error: rErr } = await supabase.from('business_settings').select('id')
    .eq('business_id', req.businessId).eq('key', CREDIT_APPROVERS_KEY).maybeSingle();
  if (rErr) { sendError(res, rErr); return; }
  const { error } = existing
    ? await supabase.from('business_settings').update({ value: r.rule, updated_at: nowIso }).eq('business_id', req.businessId).eq('key', CREDIT_APPROVERS_KEY)
    : await supabase.from('business_settings').insert({ business_id: req.businessId, key: CREDIT_APPROVERS_KEY, value: r.rule, updated_at: nowIso });
  if (error) { sendError(res, error); return; }
  try {
    const who = await actor(req);
    await supabase.from('audit_log').insert({ business_id: req.businessId, branch_id: null, user_id: who.id, user_name: who.name,
      action: 'credit.approvers.changed', table_name: 'business_settings', record_id: null, before_data: before, after_data: r.rule });
  } catch { /* best-effort */ }
  res.json({ rule: r.rule });
});

// POST /api/credit/customer/:id/payment — record a repayment (decreases balance)
// Body: { amount, method, reference?, notes? }
// A595: recording a repayment is its own part of customers.credit (customers.credit_payment — migration 176 gave it to every
// holder of customers.credit).
router.post('/customer/:id/payment', requirePermission('customers.credit_payment'), async (req, res) => {
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
// A595: adjusting or writing off a balance is its own part of customers.credit (customers.credit_adjust).
router.post('/customer/:id/adjustment', requirePermission('customers.credit_adjust'), async (req, res) => {
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
  const f = branchFilter(req);   // A582: a partner's "All my branches" — their branches' credit sales
  const branch = f.kind === 'set' ? f.ids : branchScope(req);
  const [rows, counts] = await Promise.all([
    listCreditSales(req.businessId!, branch, states, Number(req.query.limit) || 200),
    creditCounts(req.businessId!, branch),
  ]);
  res.json({ rows, counts, notice: awaitingSentence(counts.awaiting) });
});

// GET /api/credit/sales/count — the badge, and the Close Day / Close Branch notice (whoever closes the day reads it too).
// NEVER blocks a close (the owner: no deadlocks) — it only says how many wait.
router.get('/sales/count', requireAnyPermission('customers.credit', 'shifts.close_day', 'shifts.close_branch'), async (req, res) => {
  const f = branchFilter(req);   // A582
  const counts = await creditCounts(req.businessId!, f.kind === 'set' ? f.ids : branchScope(req));
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
  if (req.isTill) { res.status(403).json({ error: "A POS sends a manager's decision as a replay.", code: 'TILL_SENDS_REPLAY' }); return; }
  creditKey(req, res, next);
};
const tillGate = (req: any, res: any, next: any) => {
  if (req.isTill === true && !!req.deviceId) { next(); return; }
  res.status(403).json({ error: "Only a POS sends a replay — decide with your own sign-in.", code: 'REPLAY_IS_THE_TILLS' });
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
  // A587 (owner, 2026-10-24: "Is confirming a waiting credit sale limited to the approvers? — yes"): with approval ON only
  // the sale's branch's chosen approvers (and the owner) confirm or dispute it — on the web, on the POS, or replayed by a
  // POS for someone who decided offline. OFF: the A545 rule below, as before.
  if (cur) {
    const rule = await loadCreditRule(req.businessId);
    if (rule.on) {
      const { rows, ownerId } = await confirmerRows(req.businessId);
      const personId = req.isTill ? String(req.body?.by ?? '') : String(req.userId ?? '');
      const row = rows.find((r) => r.id === personId) ?? null;
      const owner = req.isTill ? !!row && isOwnerRow(row, ownerId) : req.isOwner === true && req.webPartner !== true;
      if (!owner && !(row && mayDecideCreditSale(rule, cur.branch_id, row, { ownerId }))) {
        res.status(403).json({ ...CHOSEN_APPROVERS_DECIDE }); return;
      }
    }
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
