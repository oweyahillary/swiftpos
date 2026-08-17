import { Router } from 'express';
import { branchScope, requirePermission, requireAnyPermission } from '../middleware/rbac';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { chunkIn, fetchAllIds } from '../lib/pgQuery';
import { validate } from '../middleware/validate';
import { OpenShiftSchema, CloseShiftSchema } from '../lib/schemas';
import { terminalKey, terminalKeyFromRequest, deviceIdFromRequest } from '../lib/terminalKey';

const router = safeRouter();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/current
// Returns the caller's open shift for their branch (if any).
// Used by the POS on boot to resume a session.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/current', async (req, res) => {
  // A shift is the terminal's open drawer session, NOT the logged-in cashier's.
  // Whoever is on this terminal shares its session. Resolving by cashier_id (the
  // old behaviour) meant a cashier who opened a drawer on T1 and then logged into
  // T2 pulled their T1 shift onto T2, so T2's sales and cash landed on T1's
  // drawer. Resolve by terminal so the session follows the register.
  const tkey = terminalKeyFromRequest(req);
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false });

  if (error) { sendError(res, error); return; }

  // The terminal key is computed the same way as the SQL function, so filter in
  // JS against the resolved key rather than trying to reproduce COALESCE in a
  // PostgREST query. At most one row matches (the unique index guarantees it).
  const match = (data ?? []).find(
    s => terminalKey(s.device_id ?? '', s.terminal_code ?? '', s.branch_id ?? '') === tkey,
  );
  res.json(match ?? null);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/open
// Opens a new shift. Rejects if the cashier already has an open shift.
// Body: { branch_id, opening_float }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/open', validate(OpenShiftSchema), async (req, res) => {
  const { branch_id, opening_float = 0 } = req.body;

  if (!branch_id) {
    res.status(400).json({ error: 'branch_id is required' });
    return;
  }

  // Guard: no duplicate open shifts for this cashier.
  //
  // This used to call .maybeSingle() and destructure only `data`. maybeSingle()
  // returns an ERROR and null data when MORE than one row matches, so once a
  // cashier had accumulated two open shifts — which /api/sync/push could create,
  // having no guard of its own — `existing` came back null, this check passed,
  // and the route opened a third. It failed open at exactly the point the thing
  // it guards against had already happened twice.
  //
  // One open session per TERMINAL, not per cashier. If this terminal already
  // has an open drawer, it must be closed (counted) before a new one opens —
  // whoever is next on the terminal resumes the same session by selling into it.
  const tkey = terminalKeyFromRequest(req);
  const { data: openShifts, error: guardError } = await supabase
    .from('shifts')
    .select('id, branch_id, device_id, terminal_code, opened_at')
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .order('opened_at', { ascending: true });

  // Never fall through to the insert on a failed read: not knowing whether a
  // shift is open is not the same as knowing none is.
  if (guardError) { sendError(res, guardError); return; }

  const onThisTerminal = (openShifts ?? []).filter(
    s => terminalKey(s.device_id ?? '', s.terminal_code ?? '', s.branch_id ?? '') === tkey,
  );

  if (onThisTerminal.length > 0) {
    const oldest = onThisTerminal[0];
    res.status(409).json({
      error: 'This terminal already has an open drawer session. Close it before opening a new one.',
      shiftId: oldest.id,
      terminal: oldest.terminal_code ?? oldest.device_id ?? null,
      openedAt: oldest.opened_at,
      openShiftCount: onThisTerminal.length,
    });
    return;
  }

  // deviceIdFromRequest, not a raw header read — a duplicated header arrives
  // comma-joined, and this value keys the one-open-drawer index. terminalKey.ts.
  const deviceId     = deviceIdFromRequest(req) || null;
  const terminalCode = (req.body?.terminal_code as string | undefined)?.trim() || null;

  const { data, error } = await supabase
    .from('shifts')
    .insert({
      business_id: req.businessId,
      branch_id,
      // cashier_id records WHO opened the drawer. Attribution of individual sales
      // is on each order (orders.cashier_id); the session is the drawer's, and
      // may be shared by several cashiers over its life.
      cashier_id: req.userId,
      opened_by:  req.userId,
      device_id:     deviceId,
      terminal_code: terminalCode,
      opening_float: Number(opening_float),
      status: 'open',
    })
    .select()
    .single();

  if (error) {
    // The guard above is a read-then-write, so two concurrent requests can both
    // pass it. shifts_one_open_per_terminal (migration 63) is what actually
    // decides, and it surfaces here as 23505. Same condition as the 409 above,
    // not a server fault — so it must not be reported as one.
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({
        error: 'This terminal already has an open drawer session. Close it before opening a new one.',
      });
      return;
    }
    sendError(res, error);
    return;
  }
  res.status(201).json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/:id/close
// Closes a shift with a cash count and optional notes.
// Calculates expected cash and variance automatically.
// Body: { closing_float, notes? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/close', validate(CloseShiftSchema), async (req, res) => {
  const { id } = req.params;
  const { closing_float, notes, denomination_breakdown } = req.body;

  if (closing_float === undefined || closing_float === null) {
    res.status(400).json({ error: 'closing_float is required' });
    return;
  }

  // If a denomination breakdown was supplied, verify it sums to closing_float
  // (guards against a UI/transport mismatch between the count and the total).
  if (denomination_breakdown && typeof denomination_breakdown === 'object') {
    const summed = Object.entries(denomination_breakdown)
      .reduce((s, [denom, count]) => s + Number(denom) * Number(count), 0);
    if (Math.round(summed * 100) !== Math.round(Number(closing_float) * 100)) {
      res.status(400).json({
        error: `Denomination count (${summed.toFixed(2)}) does not match closing float (${Number(closing_float).toFixed(2)})`,
      });
      return;
    }
  }

  // Fetch the shift (must belong to this business and be open)
  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('*')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .single();

  if (shiftErr || !shift) {
    res.status(404).json({ error: 'Open shift not found' });
    return;
  }

  // ── Authorisation (finding #13) ──────────────────────────────────────────
  // Previously ANY authenticated user in the business could close ANY drawer,
  // from any terminal, with any cash count — a fraud vector and a data-integrity
  // hole (a stranger's count lands on a drawer they never touched). A drawer may
  // be closed by:
  //   * the cashier who opened it (opened_by / cashier_id), or
  //   * a cashier physically on that same terminal (they share the session), or
  //   * a manager (permission 'shifts.manage' — the same gate force-close uses).
  const sameTerminal =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '')
      === terminalKeyFromRequest(req);
  const openedByRequester = shift.opened_by === req.userId || shift.cashier_id === req.userId;
  const keys = req.permissionKeys ?? [];
  const isManager = req.isOwner || keys.includes('*') || keys.includes('shifts.manage');

  if (!openedByRequester && !sameTerminal && !isManager) {
    res.status(403).json({
      error: 'You can only close a drawer you opened or are working on. Ask a manager to close another terminal\'s drawer.',
    });
    return;
  }

  // Sum all completed CASH payments for orders belonging to this shift.
  // Use orders → payments direction (more reliable than the !inner embed
  // syntax which is PostgREST-version sensitive and fails on some Supabase tiers).
  // Paged: a plain .select('id') silently truncates at Supabase's row cap, and
  // expected cash computed from a TRUNCATED order list reports a large phantom
  // surplus at close with no error. See lib/pgQuery.ts.
  let orderIds: string[];
  try {
    orderIds = await fetchAllIds('orders', q => q.eq('shift_id', id).eq('status', 'completed'));
  } catch (e) { sendError(res, e as Error); return; }

  let cashSales = 0;
  if (orderIds.length > 0) {
    // Completed AND refunded rows.
    //
    // A refund inserts a NEGATIVE cash row with status 'refunded'. Filtering to
    // 'completed' alone counted the money in and not the money back out, so
    // expected cash was overstated by every refund and the drawer read short by
    // exactly that amount — an unexplained shortage at close, which is the
    // single most corrosive thing a till can report. Audit finding M8.
    //
    // A void needs no such handling: the order itself leaves the set above, so
    // both its legs disappear together.
    // chunkIn, not a bare .in(): PostgREST puts the id list in the URL, and a
    // shift with more than ~220 orders overflows the 8KB request line every
    // proxy in the path allows. See lib/pgQuery.ts.
    let cashPayments: Array<{ amount: string | number; status: string }>;
    try {
      cashPayments = await chunkIn<{ amount: string | number; status: string }>(
        'payments', 'order_id', orderIds,
        q => q.select('amount, status').eq('method', 'cash').in('status', ['completed', 'refunded']),
      );
    } catch (e) { sendError(res, e as Error); return; }
    cashSales = cashPayments.reduce((sum, p) => sum + Number(p.amount), 0);
  }

  // Sum float_out movements (cash removed from drawer)
  const { data: floatTxns } = await supabase
    .from('float_transactions')
    .select('type, amount')
    .eq('shift_id', id);

  const floatIn  = (floatTxns ?? []).filter(f => f.type === 'float_in') .reduce((s, f) => s + Number(f.amount), 0);
  const floatOut = (floatTxns ?? []).filter(f => f.type === 'float_out').reduce((s, f) => s + Number(f.amount), 0);

  const expensesOut   = await shiftExpenses(id);
  const expectedCash  = Number(shift.opening_float) + cashSales + floatIn - floatOut - expensesOut;
  const cashVariance  = Number(closing_float) - expectedCash;

  // Require an explanatory note whenever the count doesn't match expected cash.
  if (Math.round(cashVariance * 100) !== 0 && !(notes && notes.trim())) {
    res.status(400).json({
      error: 'A note is required to close a shift with a cash variance',
      variance: cashVariance,
      expected_cash: expectedCash,
    });
    return;
  }

  const { data: closed, error: closeErr } = await supabase
    .from('shifts')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      closed_by: req.userId,
      close_method: 'counted',
      closing_float: Number(closing_float),
      expected_cash: expectedCash,
      cash_variance: cashVariance,
      notes: notes ?? null,
      denomination_breakdown: denomination_breakdown ?? null,
    })
    .eq('id', id)
    .select()
    .single();

  if (closeErr) { sendError(res, closeErr); return; }
  res.json(closed);
});


/**
 * Cash paid out of a drawer as recorded EXPENSES.
 *
 * Must be subtracted from expected cash. Expenses are written without a matching
 * float_out, so cash leaves the drawer while expected_cash does not move — a
 * cashier who paid a supplier from the till and recorded it honestly counted
 * short at close and was reported as down by exactly that amount, indistinguishable
 * from someone who had simply taken it.
 *
 * Kept identical to the desktop's computeZReport, deliberately: the offline
 * Z-report the cashier signs and the figure the server stores on close have to be
 * the same number, or every reconciliation becomes an argument about which
 * screen to believe.
 */
async function shiftExpenses(shiftId: string): Promise<number> {
  const { data } = await supabase
    .from('expenses').select('amount').eq('shift_id', shiftId);
  return (data ?? []).reduce((sum, e: { amount: number }) => sum + Number(e.amount), 0);
}

/**
 * Expected cash in a drawer right now, for ONE shift.
 *
 *     opening_float + cash_sales + float_in - float_out - expenses
 *
 * Extracted so the open-shift list can show a manager what they are about to
 * write off before force-closing a dead terminal's drawer. Previously this lived
 * inline in /close only, so the figure existed exactly at the moment it was too
 * late to be useful.
 *
 * Refunds are included as NEGATIVE cash rows (status 'refunded'): omitting them
 * overstated expected cash by every refund and made the drawer read short by that
 * amount — an unexplained shortage, which is the most corrosive thing a till can
 * report. Audit finding M8.
 */
async function computeExpectedCash(shiftId: string, openingFloat: number): Promise<number> {
  // Paged: a plain .select('id') silently truncates at Supabase's row cap, and
  // expected cash computed from a TRUNCATED order list reports a large phantom
  // surplus at close with no error anywhere. See lib/pgQuery.ts.
  const orderIds = await fetchAllIds('orders', q =>
    q.eq('shift_id', shiftId).eq('status', 'completed'));

  let cashSales = 0;
  if (orderIds.length > 0) {
    const cashPayments = await chunkIn<{ amount: number; status: string }>(
      'payments', 'order_id', orderIds,
      q => q.select('amount, status').eq('method', 'cash').in('status', ['completed', 'refunded']),
    );
    cashSales = cashPayments.reduce((s, p: { amount: number }) => s + Number(p.amount), 0);
  }

  const { data: floatTxns } = await supabase
    .from('float_transactions').select('type, amount').eq('shift_id', shiftId);
  const floatIn  = (floatTxns ?? []).filter(f => f.type === 'float_in') .reduce((s, f) => s + Number(f.amount), 0);
  const floatOut = (floatTxns ?? []).filter(f => f.type === 'float_out').reduce((s, f) => s + Number(f.amount), 0);

  const expenses = await shiftExpenses(shiftId);
  return Number(openingFloat) + cashSales + floatIn - floatOut - expenses;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/:id/force-close
// Ends a shift NOBODY COUNTED. Manager-only.
//
// WHY THIS HAS TO EXIST
//   A cashier who abandons a drawer leaves a shift open forever. The till can
//   force-close it locally, but there was no server-side counterpart — so
//   syncEngine.reconcileClosedShifts() (which selects status='closed') never
//   matched it, never posted anything, and the row stayed 'open' in Postgres
//   permanently. With shifts_one_open_per_cashier now enforced, that stranded
//   row locks the cashier out of every surface for good, fixable only by hand
//   in the database.
//
//   It cannot reuse /:id/close: that requires a closing_float, and the entire
//   point here is that no count exists.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   No closing_float, no cash_variance — they stay NULL, never 0. A zero
//   variance asserts that somebody checked and it balanced. Nobody checked.
//   expected_cash IS computed, because what the drawer SHOULD have held is
//   knowable from the sales and is exactly what an investigation needs.
//
// Permission: settings.manage — the same key the desktop uses for manager
// rights (see App.tsx hasManagerRights), so the two surfaces agree on who is a
// manager rather than drifting apart.
// ─────────────────────────────────────────────────────────────────────────────
// requireAnyPermission (A59): the dedicated `shifts.force_close` key OR the
// broad `settings.manage` — additive, so anyone who could force-close before
// (via settings.manage) still can, and the now-granted key (migration 83) works.
router.post('/:id/force-close', requireAnyPermission('shifts.force_close', 'settings.manage'), async (req, res) => {
  const { id } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  // A forced close with no stated reason is an unexplained hole in the cash
  // record, which is worse than the open shift it replaces.
  if (!reason) {
    res.status(400).json({ error: 'A reason is required to force-close a shift' });
    return;
  }

  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('*')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .single();

  if (shiftErr || !shift) {
    res.status(404).json({ error: 'Open shift not found' });
    return;
  }

  // Same expected-cash formula as /:id/close, including refunds as negative
  // cash rows — see the comment there for why omitting them overstates expected.
  // Paged: a plain .select('id') silently truncates at Supabase's row cap, and
  // expected cash computed from a TRUNCATED order list reports a large phantom
  // surplus at close with no error. See lib/pgQuery.ts.
  let orderIds: string[];
  try {
    orderIds = await fetchAllIds('orders', q => q.eq('shift_id', id).eq('status', 'completed'));
  } catch (e) { sendError(res, e as Error); return; }

  let cashSales = 0;
  if (orderIds.length > 0) {
    // chunkIn, not a bare .in(): PostgREST puts the id list in the URL, and a
    // shift with more than ~220 orders overflows the 8KB request line every
    // proxy in the path allows. See lib/pgQuery.ts.
    let cashPayments: Array<{ amount: string | number; status: string }>;
    try {
      cashPayments = await chunkIn<{ amount: string | number; status: string }>(
        'payments', 'order_id', orderIds,
        q => q.select('amount, status').eq('method', 'cash').in('status', ['completed', 'refunded']),
      );
    } catch (e) { sendError(res, e as Error); return; }
    cashSales = cashPayments.reduce((sum, p) => sum + Number(p.amount), 0);
  }

  const { data: floatTxns } = await supabase
    .from('float_transactions').select('type, amount').eq('shift_id', id);
  const floatIn  = (floatTxns ?? []).filter(f => f.type === 'float_in') .reduce((s, f) => s + Number(f.amount), 0);
  const floatOut = (floatTxns ?? []).filter(f => f.type === 'float_out').reduce((s, f) => s + Number(f.amount), 0);

  const expensesOut = await shiftExpenses(id);
  const expectedCash = Number(shift.opening_float) + cashSales + floatIn - floatOut - expensesOut;

  const { data: closed, error: closeErr } = await supabase
    .from('shifts')
    .update({
      status: 'closed_unreconciled',
      close_method: 'forced',
      closed_at: new Date().toISOString(),
      closed_by: req.userId,
      expected_cash: expectedCash,
      closing_float: null,
      cash_variance: null,
      notes: [shift.notes, `Force-closed by manager: ${reason}`].filter(Boolean).join('\n'),
    })
    .eq('id', id)
    .select()
    .single();

  if (closeErr) { sendError(res, closeErr); return; }
  res.json(closed);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/:id/float
// Records a float_in or float_out transaction during an open shift.
// Body: { type: 'float_in'|'float_out', amount, reason? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/float', async (req, res) => {
  const { id } = req.params;
  const { type, amount, reason } = req.body;

  if (!type || !amount || !['float_in', 'float_out'].includes(type)) {
    res.status(400).json({ error: 'type (float_in|float_out) and amount are required' });
    return;
  }
  if (Number(amount) <= 0) {
    res.status(400).json({ error: 'amount must be greater than zero' });
    return;
  }

  // Verify shift is open and belongs to this business
  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('id, branch_id, status')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .single();

  if (shiftErr || !shift) {
    res.status(404).json({ error: 'Open shift not found' });
    return;
  }

  const { data, error } = await supabase
    .from('float_transactions')
    .insert({
      shift_id: id,
      branch_id: shift.branch_id,
      cashier_id: req.userId,
      type,
      amount: Number(amount),
      reason: reason ?? null,
    })
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts
// Lists shifts for the business. Supports filters: branch_id, status, from, to.
// Enriches with cashier name (fetched separately to avoid Supabase FK join issues).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { status, from, to, limit = '50' } = req.query as Record<string, string>;
  const branch_id = branchScope(req);

  let query = supabase
    .from('shifts')
    .select('*')
    .eq('business_id', req.businessId)
    .order('opened_at', { ascending: false })
    .limit(Math.min(Number(limit), 200));

  if (branch_id) query = query.eq('branch_id', branch_id);
  if (status)    query = query.eq('status', status);
  if (from)      query = query.gte('opened_at', from);
  if (to)        query = query.lte('opened_at', to);

  const { data: shifts, error } = await query;
  if (error) { sendError(res, error); return; }

  if (!shifts?.length) { res.json([]); return; }

  // Fetch cashier names separately (avoid FK join issues on users table)
  const cashierIds = [...new Set(shifts.map(s => s.cashier_id))];
  const { data: users } = await supabase
    .from('users')
    .select('id, name')
    .in('id', cashierIds.slice(0, 500)); // bounded: max 500 cashiers per business

  const nameMap: Record<string, string> = {};
  (users ?? []).forEach(u => { nameMap[u.id] = u.name; });

  // For OPEN shifts, compute expected cash now. Bounded to 50 so a wide date
  // range cannot turn this into hundreds of round trips; open shifts in practice
  // number in single figures, and only they can be force-closed.
  const openOnes = shifts.filter(s => s.status === 'open').slice(0, 50);
  const expectedById = new Map<string, number>();
  await Promise.all(openOnes.map(async s => {
    try {
      expectedById.set(s.id, await computeExpectedCash(s.id, Number(s.opening_float)));
    } catch {
      /* leave absent — the UI shows "unavailable" rather than a wrong number */
    }
  }));

  const enriched = shifts.map(s => ({
    ...s,
    cashier_name: nameMap[s.cashier_id] ?? 'Unknown',
    expected_cash_live: expectedById.has(s.id) ? expectedById.get(s.id) : null,
  }));

  res.json(enriched);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/:id
// Returns a single shift with its float transactions and order summary.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const [{ data: shift, error: sErr }, { data: floatTxns }, { data: orders, error: oErr }] = await Promise.all([
    supabase
      .from('shifts')
      .select('*')
      .eq('id', id)
      .eq('business_id', req.businessId)
      .single(),
    supabase
      .from('float_transactions')
      .select('*')
      .eq('shift_id', id)
      .order('created_at'),
    supabase
      .from('orders')
      .select('id, total, created_at')
      .eq('shift_id', id)
      .eq('status', 'completed'),
  ]);

  if (sErr || !shift) { res.status(404).json({ error: 'Shift not found' }); return; }

  // Previously this query selected orders.payment_method, which is not a column.
  // The error was not destructured, so a failed query left `orders` null and the
  // Z-report showed zero revenue / zero orders instead of failing loudly.
  if (oErr) console.error('[shifts] order summary failed:', oErr.message);

  // Cashier name
  const { data: cashier } = await supabase
    .from('users')
    .select('name')
    .eq('id', shift.cashier_id)
    .single();

  const totalRevenue = (orders ?? []).reduce((s, o) => s + Number(o.total), 0);

  res.json({
    ...shift,
    cashier_name: cashier?.name ?? 'Unknown',
    float_transactions: floatTxns ?? [],
    order_count: (orders ?? []).length,
    total_revenue: totalRevenue,
  });
});

export default router;
