/**
 * /api/payables — A395: what the business owes its suppliers. The rules live in lib/payables.ts.
 *
 *   GET  /summary                 every supplier's balance, overdue and ageing        payables.manage
 *   GET  /suppliers/:id           one supplier's account: bills, payments, returns,   payables.manage
 *                                 statement, unbilled deliveries
 *   POST /bills                   record a supplier's invoice (optionally for a GRN)   payables.manage
 *   POST /bills/:id/void          void a bill nothing has been paid against             payables.manage
 *   POST /payments                pay a supplier (against a bill, or on account)       payables.manage
 *   POST /payments/:id/void       void a payment recorded by mistake                    payables.manage
 *   GET  /returns                 goods sent back                                       inventory.receive
 *   POST /returns                 send goods back: stock leaves, the supplier owes a    inventory.receive
 *                                 credit
 *
 * payables.manage is the owner's by default (migration 121, MANAGER_DENY): who is owed what, and paying it, is the
 * owner's. A manager who receives deliveries may send goods back (inventory.receive) — the credit is the goods' cost.
 */
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePermission, requireAnyPermission, assertBranchAccess, branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { chunkIn } from '../lib/pgQuery';
import { actor } from '../lib/actor';
import {
  parseAmount, cleanMethod, cleanDate, addDays, billView, paymentProblem, supplierPosition, statement, grnValue,
  payablesRef, round2, type BillLike, type PaymentLike,
} from '../lib/payables';

const router = safeRouter();
router.use(requireAuth);

const today = () => new Date().toISOString().slice(0, 10);   // the business's day boundary is not needed for dates of bills

type Bill = BillLike & { ref: string; supplier_id: string; invoice_number: string | null; grn_id: string | null; note: string | null;
  branch_id: string | null; created_at: string; created_by_name: string | null; voided_at: string | null; void_reason: string | null };
type Payment = PaymentLike & { id: string; supplier_id: string; method: string; reference: string | null; paid_on: string;
  note: string | null; created_at: string; created_by_name: string | null; void_reason?: string | null };
type Return = { id: string; ref: string; supplier_id: string; branch_id: string; return_date: string; credit_amount: number | string;
  reason: string | null; created_at: string; created_by_name: string | null; grn_id: string | null };

async function supplierOf(businessId: string, id: string): Promise<{ id: string; name: string; phone: string | null; email: string | null; status: string } | null> {
  if (!id) return null;
  const { data } = await supabase.from('suppliers').select('id, name, phone, email, status')
    .eq('id', id).eq('business_id', businessId).maybeSingle();
  return (data as { id: string; name: string; phone: string | null; email: string | null; status: string } | null) ?? null;
}

/** Deliveries (GRNs) from this supplier — through their purchase order — with their value and whether a bill covers them. */
async function deliveriesOf(businessId: string, supplierId: string) {
  const { data } = await supabase.from('goods_received_notes')
    .select('id, grn_number, received_date, branch_id, purchase_orders!inner ( po_number, supplier_id ), grn_items ( quantity_received, unit_cost )')
    .eq('business_id', businessId).eq('purchase_orders.supplier_id', supplierId)
    .order('received_date', { ascending: false }).limit(100);
  return ((data ?? []) as any[]).map((g) => ({
    id: g.id as string, grn_number: g.grn_number as string, received_date: g.received_date as string, branch_id: g.branch_id as string,
    po_number: g.purchase_orders?.po_number ?? null, value: grnValue(g.grn_items ?? []),
  }));
}

async function nextRef(table: 'supplier_bills' | 'supplier_returns', prefix: 'BILL' | 'RTN', businessId: string): Promise<string> {
  const q = table === 'supplier_bills'
    ? supabase.from('supplier_bills').select('id', { count: 'exact', head: true }).eq('business_id', businessId)
    : supabase.from('supplier_returns').select('id', { count: 'exact', head: true }).eq('business_id', businessId);
  const { count } = await q;
  return payablesRef(prefix, count ?? 0);
}

// ─── Balances ─────────────────────────────────────────────────────────────────

router.get('/summary', requirePermission('payables.manage'), async (req, res) => {
  const [{ data: sup }, { data: bills, error: bErr }, { data: pays }, { data: rets }] = await Promise.all([
    supabase.from('suppliers').select('id, name, status').eq('business_id', req.businessId).order('name'),
    supabase.from('supplier_bills').select('id, supplier_id, amount, status, bill_date, due_date').eq('business_id', req.businessId).limit(20000),
    supabase.from('supplier_payments').select('supplier_id, bill_id, amount, voided_at').eq('business_id', req.businessId).limit(20000),
    supabase.from('supplier_returns').select('supplier_id, credit_amount').eq('business_id', req.businessId).limit(20000),
  ]);
  if (bErr) { sendError(res, bErr); return; }
  const t = today();
  const by = <T extends { supplier_id: string }>(rows: T[] | null, id: string) => (rows ?? []).filter((r) => r.supplier_id === id);
  const suppliers = ((sup ?? []) as Array<{ id: string; name: string; status: string }>).map((s) => ({
    id: s.id, name: s.name, status: s.status,
    ...supplierPosition(by(bills as any[], s.id), by(pays as any[], s.id), by(rets as any[], s.id), t),
  }));
  const total = (k: 'balance' | 'overdue' | 'dueSoon') => round2(suppliers.reduce((x, s) => x + Math.max(0, s[k]), 0));
  res.json({ today: t, owed: total('balance'), overdue: total('overdue'), dueSoon: total('dueSoon'), suppliers });
});

router.get('/suppliers/:id', requirePermission('payables.manage'), async (req, res) => {
  const supplier = await supplierOf(req.businessId, req.params.id);
  if (!supplier) { res.status(404).json({ error: 'Supplier not found' }); return; }
  const [{ data: bills, error }, { data: pays }, { data: rets }, deliveries] = await Promise.all([
    supabase.from('supplier_bills').select('*').eq('business_id', req.businessId).eq('supplier_id', supplier.id).order('bill_date', { ascending: false }).limit(2000),
    supabase.from('supplier_payments').select('*').eq('business_id', req.businessId).eq('supplier_id', supplier.id).order('paid_on', { ascending: false }).limit(2000),
    supabase.from('supplier_returns').select('*, supplier_return_items ( name, quantity, unit_cost, item_kind )').eq('business_id', req.businessId).eq('supplier_id', supplier.id).order('return_date', { ascending: false }).limit(500),
    deliveriesOf(req.businessId, supplier.id),
  ]);
  if (error) { sendError(res, error); return; }
  const t = today();
  const B = (bills ?? []) as Bill[], P = (pays ?? []) as Payment[], R = (rets ?? []) as Return[];
  const billed = new Set(B.filter((b) => b.status !== 'void' && b.grn_id).map((b) => b.grn_id as string));
  res.json({
    supplier, today: t,
    position: supplierPosition(B, P, R, t),
    bills: B.map((b) => ({ ...b, ...billView(b, P, t) })),
    payments: P, returns: R,
    statement: statement(B, P, R),
    unbilled: deliveries.filter((d) => !billed.has(d.id)),
  });
});

// ─── Bills ────────────────────────────────────────────────────────────────────

router.post('/bills', requirePermission('payables.manage'), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const supplier = await supplierOf(req.businessId, String(b.supplier_id ?? ''));
  if (!supplier) { res.status(400).json({ error: 'Choose the supplier.' }); return; }
  let grn: { id: string; branch_id: string; value: number } | null = null;
  if (b.grn_id) {
    const found = (await deliveriesOf(req.businessId, supplier.id)).find((d) => d.id === String(b.grn_id));
    if (!found) { res.status(400).json({ error: 'That delivery is not from this supplier.', code: 'GRN_NOT_SUPPLIER' }); return; }
    grn = found;
  }
  const amount = parseAmount(b.amount ?? (grn ? grn.value : null));
  if (amount === null) { res.status(400).json({ error: 'Enter the bill amount (more than 0).', code: 'BAD_AMOUNT' }); return; }
  const billDate = cleanDate(b.bill_date) ?? today();
  const terms = Number(b.terms_days);
  const dueDate = cleanDate(b.due_date) ?? (Number.isInteger(terms) && terms >= 0 && terms <= 365 ? addDays(billDate, terms) : null);
  if (dueDate && dueDate < billDate) { res.status(400).json({ error: 'The due date is before the bill date.', code: 'BAD_DUE' }); return; }
  const branchId = typeof b.branch_id === 'string' && b.branch_id ? b.branch_id : grn?.branch_id ?? null;
  if (branchId && !assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'No access to that branch' }); return; }
  const who = await actor(req);
  const { data, error } = await supabase.from('supplier_bills').insert({
    business_id: req.businessId, supplier_id: supplier.id, branch_id: branchId, ref: await nextRef('supplier_bills', 'BILL', req.businessId),
    invoice_number: typeof b.invoice_number === 'string' && b.invoice_number.trim() ? b.invoice_number.trim().slice(0, 60) : null,
    bill_date: billDate, due_date: dueDate, amount, grn_id: grn?.id ?? null,
    note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 300) : null,
    created_by: who.id, created_by_name: who.name,
  }).select('*').single();
  if (error) {
    if ((error as { code?: string }).code === '23505') { res.status(409).json({ error: 'That delivery already has a bill.', code: 'GRN_BILLED' }); return; }
    sendError(res, error); return;
  }
  res.status(201).json(data);
});

router.post('/bills/:id/void', requirePermission('payables.manage'), async (req, res) => {
  const { data: bill } = await supabase.from('supplier_bills').select('id, status')
    .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
  if ((bill as { status: string }).status === 'void') { res.status(409).json({ error: 'Already voided.' }); return; }
  const { count } = await supabase.from('supplier_payments').select('id', { count: 'exact', head: true })
    .eq('bill_id', req.params.id).is('voided_at', null);
  if (count) { res.status(409).json({ error: 'Payments are recorded against this bill — void them first.', code: 'BILL_HAS_PAYMENTS' }); return; }
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) { res.status(400).json({ error: 'Say why the bill is voided.', code: 'REASON_REQUIRED' }); return; }
  const who = await actor(req);
  const { error } = await supabase.from('supplier_bills')
    .update({ status: 'void', voided_at: new Date().toISOString(), voided_by_name: who.name, void_reason: reason.slice(0, 300) })
    .eq('id', req.params.id).eq('business_id', req.businessId).eq('status', 'open');
  if (error) { sendError(res, error); return; }
  res.json({ status: 'void' });
});

// ─── Payments ─────────────────────────────────────────────────────────────────

router.post('/payments', requirePermission('payables.manage'), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const supplier = await supplierOf(req.businessId, String(b.supplier_id ?? ''));
  if (!supplier) { res.status(400).json({ error: 'Choose the supplier.' }); return; }
  const amount = parseAmount(b.amount);
  if (amount === null) { res.status(400).json({ error: 'Enter the amount paid (more than 0).', code: 'BAD_AMOUNT' }); return; }
  const method = cleanMethod(b.method);
  if (!method) { res.status(400).json({ error: 'Choose how it was paid: cash, M-Pesa, bank, cheque or other.', code: 'BAD_METHOD' }); return; }
  let bill: Bill | null = null;
  if (b.bill_id) {
    const { data } = await supabase.from('supplier_bills').select('*')
      .eq('id', String(b.bill_id)).eq('business_id', req.businessId).eq('supplier_id', supplier.id).maybeSingle();
    if (!data) { res.status(400).json({ error: 'That bill is not this supplier\'s.' }); return; }
    bill = data as Bill;
    const { data: paid } = await supabase.from('supplier_payments').select('bill_id, amount, voided_at').eq('bill_id', bill.id);
    const problem = paymentProblem(bill, (paid ?? []) as PaymentLike[], amount, today());
    if (problem) { res.status(409).json({ error: problem, code: 'OVERPAY' }); return; }
  }
  const who = await actor(req);
  const { data, error } = await supabase.from('supplier_payments').insert({
    business_id: req.businessId, supplier_id: supplier.id, bill_id: bill?.id ?? null, amount, method,
    reference: typeof b.reference === 'string' && b.reference.trim() ? b.reference.trim().slice(0, 60) : null,
    paid_on: cleanDate(b.paid_on) ?? today(),
    note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 300) : null,
    created_by: who.id, created_by_name: who.name,
  }).select('*').single();
  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

router.post('/payments/:id/void', requirePermission('payables.manage'), async (req, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) { res.status(400).json({ error: 'Say why the payment is voided.', code: 'REASON_REQUIRED' }); return; }
  const who = await actor(req);
  const { data, error } = await supabase.from('supplier_payments')
    .update({ voided_at: new Date().toISOString(), voided_by_name: who.name, void_reason: reason.slice(0, 300) })
    .eq('id', req.params.id).eq('business_id', req.businessId).is('voided_at', null).select('id');
  if (error) { sendError(res, error); return; }
  if (!data?.length) { res.status(404).json({ error: 'Payment not found, or already voided.' }); return; }
  res.json({ voided: true });
});

// ─── Returns to supplier ──────────────────────────────────────────────────────

router.get('/returns', requireAnyPermission('inventory.receive', 'payables.manage'), async (req, res) => {
  const scoped = branchScope(req);
  let q = supabase.from('supplier_returns')
    .select('*, suppliers ( name ), supplier_return_items ( name, quantity, unit_cost, item_kind )')
    .eq('business_id', req.businessId).order('created_at', { ascending: false }).limit(100);
  if (scoped) q = q.eq('branch_id', scoped);
  if (typeof req.query.supplier_id === 'string') q = q.eq('supplier_id', req.query.supplier_id);
  const { data, error } = await q;
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

router.post('/returns', requireAnyPermission('inventory.receive', 'payables.manage'), async (req, res) => {
  const b = (req.body ?? {}) as { supplier_id?: string; branch_id?: string; grn_id?: string; reason?: string; return_date?: string;
    items?: Array<{ kind?: string; id?: string; quantity?: unknown; unit_cost?: unknown }> };
  const supplier = await supplierOf(req.businessId, String(b.supplier_id ?? ''));
  if (!supplier) { res.status(400).json({ error: 'Choose the supplier.' }); return; }
  const branchId = b.branch_id || req.branchId;
  if (!branchId) { res.status(400).json({ error: 'Choose the branch the goods leave from.' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You can only send goods back from your own branch.' }); return; }
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length || raw.length > 200) { res.status(400).json({ error: 'Add the items going back (1 to 200).' }); return; }
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 300) : '';
  if (!reason) { res.status(400).json({ error: 'Say why the goods are going back (damaged, expired, wrong item…).', code: 'REASON_REQUIRED' }); return; }

  // The items, as this business knows them (name, cost, how it is counted), and what the branch holds of each.
  const pIds = raw.filter((i) => i.kind === 'product').map((i) => String(i.id ?? ''));
  const iIds = raw.filter((i) => i.kind === 'ingredient').map((i) => String(i.id ?? ''));
  const prods = await chunkIn<{ id: string; name: string; sold_by: string | null; cost_price: number | null; business_id: string }>(
    'products', 'id', pIds, (q) => q.select('id, name, sold_by, cost_price, business_id').eq('business_id', req.businessId));
  const ings = await chunkIn<{ id: string; name: string; unit_cost: number | null; business_id: string }>(
    'ingredients', 'id', iIds, (q) => q.select('id, name, unit_cost, business_id').eq('business_id', req.businessId));
  const pLevels = await chunkIn<{ product_id: string; quantity: number | string; qty_pieces: number | string }>(
    'stock_levels', 'product_id', pIds, (q) => q.select('product_id, quantity, qty_pieces').eq('branch_id', branchId));
  const iLevels = await chunkIn<{ ingredient_id: string; current_stock: number | string }>(
    'ingredient_stock_levels', 'ingredient_id', iIds, (q) => q.select('ingredient_id, current_stock').eq('branch_id', branchId));
  const P = new Map(prods.map((p) => [p.id, p])), I = new Map(ings.map((i) => [i.id, i]));
  const pHeld = new Map(pLevels.map((l) => [l.product_id, l])), iHeld = new Map(iLevels.map((l) => [l.ingredient_id, Number(l.current_stock) || 0]));

  type Line = { item_kind: 'product' | 'ingredient'; product_id: string | null; ingredient_id: string | null; name: string; quantity: number; unit_cost: number | null; byPiece: boolean };
  const lines: Line[] = [];
  for (const it of raw) {
    const qty = parseAmount(it.quantity);
    const cost = it.unit_cost === undefined || it.unit_cost === null || it.unit_cost === '' ? null : Number(it.unit_cost);
    if (it.kind === 'product') {
      const p = P.get(String(it.id));
      if (!p) { res.status(400).json({ error: 'An item is not in this business\'s catalogue.' }); return; }
      const byPiece = p.sold_by === 'piece';
      if (qty === null || (byPiece && !Number.isInteger(qty))) { res.status(400).json({ error: `${p.name}: enter how many go back${byPiece ? ' (whole pieces)' : ''}.` }); return; }
      const lvl = pHeld.get(p.id);
      const held = Number(byPiece ? lvl?.qty_pieces : lvl?.quantity) || 0;
      if (qty > held + 0.004) { res.status(409).json({ error: `${p.name}: only ${held} at this branch.`, code: 'MORE_THAN_HELD' }); return; }
      lines.push({ item_kind: 'product', product_id: p.id, ingredient_id: null, name: p.name, quantity: qty, byPiece,
        unit_cost: cost !== null && Number.isFinite(cost) && cost >= 0 ? round2(cost) : p.cost_price === null ? null : Number(p.cost_price) });
    } else if (it.kind === 'ingredient') {
      const g = I.get(String(it.id));
      if (!g) { res.status(400).json({ error: 'An item is not in this business\'s catalogue.' }); return; }
      if (qty === null) { res.status(400).json({ error: `${g.name}: enter how much goes back.` }); return; }
      const held = iHeld.get(g.id) ?? 0;
      if (qty > held + 0.004) { res.status(409).json({ error: `${g.name}: only ${held} at this branch.`, code: 'MORE_THAN_HELD' }); return; }
      lines.push({ item_kind: 'ingredient', product_id: null, ingredient_id: g.id, name: g.name, quantity: qty, byPiece: false,
        unit_cost: cost !== null && Number.isFinite(cost) && cost >= 0 ? round2(cost) : g.unit_cost === null ? null : Number(g.unit_cost) });
    } else {
      res.status(400).json({ error: 'Each item is a product or an ingredient.' }); return;
    }
  }
  const credit = round2(lines.reduce((s, l) => s + l.quantity * (l.unit_cost ?? 0), 0));
  const who = await actor(req);
  const ref = await nextRef('supplier_returns', 'RTN', req.businessId);
  const { data: ret, error } = await supabase.from('supplier_returns').insert({
    business_id: req.businessId, supplier_id: supplier.id, branch_id: branchId, ref,
    grn_id: typeof b.grn_id === 'string' && b.grn_id ? b.grn_id : null,
    return_date: cleanDate(b.return_date) ?? today(), reason, credit_amount: credit,
    created_by: who.id, created_by_name: who.name,
  }).select('*').single();
  if (error) { sendError(res, error); return; }
  const r = ret as Return;
  const { error: iErr } = await supabase.from('supplier_return_items').insert(lines.map((l) => ({
    return_id: r.id, item_kind: l.item_kind, product_id: l.product_id, ingredient_id: l.ingredient_id, name: l.name,
    quantity: l.quantity, unit_cost: l.unit_cost,
  })));
  if (iErr) { await supabase.from('supplier_returns').delete().eq('id', r.id); sendError(res, iErr); return; }

  // The stock leaves the branch — atomic, and each change names the return.
  const failed: string[] = [];
  for (const l of lines) {
    const note = `Returned to ${supplier.name} — ${ref}: ${reason}`.slice(0, 300);
    if (l.item_kind === 'product') {
      const { data: adj, error: aErr } = await supabase.rpc('adjust_product_stock', {
        p_product_id: l.product_id, p_branch_id: branchId,
        p_qty_delta: l.byPiece ? 0 : -l.quantity, p_piece_delta: l.byPiece ? -Math.round(l.quantity) : 0,
      });
      if (aErr) { failed.push(l.name); continue; }
      const row = Array.isArray(adj) ? adj[0] : adj;
      await supabase.from('stock_movements').insert({
        product_id: l.product_id, branch_id: branchId, movement_type: 'write_off', quantity_change: -l.quantity,
        quantity_after: Number(l.byPiece ? row?.qty_pieces : row?.quantity) || 0, notes: note,
        reference_type: 'supplier_return', reference_id: r.id, created_by: who.id,
      });
    } else {
      const { data: after, error: aErr } = await supabase.rpc('adjust_ingredient_stock', {
        p_ingredient_id: l.ingredient_id, p_branch_id: branchId, p_business_id: req.businessId, p_delta: -l.quantity,
      });
      if (aErr) { failed.push(l.name); continue; }
      await supabase.from('ingredient_stock_movements').insert({
        business_id: req.businessId, ingredient_id: l.ingredient_id, branch_id: branchId, movement_type: 'adjustment',
        quantity_change: -l.quantity, quantity_after: Number(after) || 0, notes: note,
        reference_type: 'supplier_return', reference_id: r.id, created_by: who.id,
      });
    }
  }
  if (failed.length) {
    res.status(500).json({ error: `${ref} was recorded, but stock could not be taken off for ${failed.join(', ')} — correct it on the stock screen.`, code: 'STOCK_NOT_MOVED', id: r.id });
    return;
  }
  res.status(201).json({ ...r, items: lines.length });
});

export default router;
