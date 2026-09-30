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
import { openDrawersByTill, type OpenShiftRow } from '../lib/tillShifts';
import { webTillName } from '../lib/terminalLabel';
import { foreignCash, foreignOrders, type CloudOrder } from '../lib/foreignCash';
import { recorderId } from '../lib/expenseRecorder';
import { siblingsOf, siblingSummary, closedWithTillNote, type SiblingCash } from '../lib/siblingDrawers';
import { findApprover, type ApproverRow } from '../lib/approver';
import { mayConfirm, callerMayConfirm, methodMap, confirmationLines, isSelfConfirm, replayTime, type MethodMap } from '../lib/shiftConfirm';
import { verifyPin } from './auth';
import bcrypt from 'bcrypt';

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
// GET /api/shifts/terminals?branch_id=...
// Lists the enrolled tills for a branch so a web POS — which has no device_id of
// its own — can pick which till it is COVERING and adopt that till's identity
// (A273, Option B). The web then sends the chosen device_id as x-device-id on
// every request, so its shift folds into that till's drawer instead of the
// shared web:<branch> session. Any authenticated POS session may read its OWN
// business's tills for a branch: the response is device labels + ids scoped to
// req.businessId, so a foreign branch_id resolves to nothing. Minimal shape by
// design — no telemetry, no cash.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/terminals', async (req, res) => {
  const branchId = (req.query.branch_id as string | undefined)?.trim() || '';
  if (!branchId) { res.json([]); return; }
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id, terminal_code, device_label')
    .eq('business_id', req.businessId)
    .eq('branch_id', branchId)
    .eq('status', 'approved')
    .is('retired_at', null)
    .not('device_id', 'is', null);
  if (error) { sendError(res, error); return; }
  // De-dupe by device_id and drop any the web can't key on.
  const seen = new Set<string>();
  const tills = (data ?? []).filter((d: any) => {
    if (!d.device_id || seen.has(d.device_id)) return false;
    seen.add(d.device_id); return true;
  }).map((d: any) => ({
    device_id:     d.device_id,
    terminal_code: d.terminal_code ?? null,
    device_label:  d.device_label ?? null,
  }));
  res.json(tills);
});

// ──────────────────────────────────────────────────────────
// GET /api/shifts/terminals/open?branch_id=...
// A273 follow-up (2026-09-26): the branch's OPEN drawers, one per till, with who opened
// each and when — never an amount. The web POS merges this with /terminals so it can
// join the cashier's own open till silently (no picker, no float) and show every other
// till as "open — Jane, since 09:02"; joining an open drawer never asks for a float
// (the 2026-09-15 target finding). Additive: /terminals is unchanged, and a web page
// talking to an older cloud gets a 404 here and keeps the picker behaviour.
// Scoped like /terminals: the caller's business and the requested branch.
// ──────────────────────────────────────────────────────────
router.get('/terminals/open', async (req, res) => {
  const branchId = (req.query.branch_id as string | undefined)?.trim() || '';
  if (!branchId) { res.json([]); return; }
  const { data, error } = await supabase
    .from('shifts')
    .select('id, device_id, opened_at, opened_by, cashier_id')
    .eq('business_id', req.businessId)
    .eq('branch_id', branchId)
    .eq('status', 'open')
    .not('device_id', 'is', null);
  if (error) { sendError(res, error); return; }
  const open = (data ?? []) as OpenShiftRow[];
  const who = [...new Set(open.map((o) => o.opened_by ?? o.cashier_id).filter(Boolean))] as string[];
  const nameById: Record<string, string> = {};
  if (who.length) {
    const { data: users } = await supabase.from('users').select('id, name').eq('business_id', req.businessId).in('id', who);
    for (const u of users ?? []) nameById[(u as any).id] = (u as any).name;
  }
  res.json(openDrawersByTill(open, nameById));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/web-till?branch_id=
// A343 (2026-09-27): the branch's WEB till — its name ("<Branch> Web Till") and whether its drawer is open (who, since
// when; no amounts). The web POS offers it as the place a cashier starts their OWN shift instead of joining a till's.
// Its drawer is the branch's web:<branchId> session: shifts opened on the web while covering no till.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/web-till', async (req, res) => {
  const branchId = (req.query.branch_id as string | undefined)?.trim() || '';
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  const { data: branch } = await supabase
    .from('branches').select('id, name').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  const { data, error } = await supabase
    .from('shifts')
    .select('id, device_id, terminal_code, branch_id, opened_at, opened_by, cashier_id')
    .eq('business_id', req.businessId)
    .eq('branch_id', branchId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false });
  if (error) { sendError(res, error); return; }
  const webKey = terminalKey('', '', branchId);
  const mine = (data ?? []).find((s: any) => terminalKey(s.device_id ?? '', s.terminal_code ?? '', s.branch_id ?? '') === webKey) as any;
  let open_shift: { id: string; opened_at: string; opened_by: string | null; opened_by_name: string | null } | null = null;
  if (mine) {
    const who = mine.opened_by ?? mine.cashier_id ?? null;
    const { data: u } = who ? await supabase.from('users').select('name').eq('id', who).eq('business_id', req.businessId).maybeSingle() : { data: null };
    open_shift = { id: mine.id, opened_at: mine.opened_at, opened_by: who, opened_by_name: (u as any)?.name ?? null };
  }
  res.json({ name: webTillName((branch as any).name), open_shift });
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
// ──────────────────────────────────────────────────────────
// POST /api/shifts/:id/foreign-cash   body: { order_ids, float_ids, expense_ids }
// A334 (2026-09-26): the cash on this drawer that the calling till does NOT hold —
// sales, floats and expenses rung on the web POS standing in for it (or on another
// surface). The till adds it to its own close so a shared drawer reconciles (owner:
// the close INCLUDES the web's sales). Read-only; the same arithmetic as /:id/close
// (lib/foreignCash.ts). Authorised like /:id/close: the opener, a cashier on the
// same terminal, or a manager — a stranger cannot read another drawer's cash.
// ──────────────────────────────────────────────────────────
router.post('/:id/foreign-cash', async (req, res) => {
  const { id } = req.params;
  const { data: shift } = await supabase
    .from('shifts').select('id, status, device_id, terminal_code, branch_id, opened_by, cashier_id')
    .eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }

  const sameTerminal =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') === terminalKeyFromRequest(req);
  const openedByRequester = shift.opened_by === req.userId || shift.cashier_id === req.userId;
  const keys = req.permissionKeys ?? [];
  const isManager = req.isOwner || keys.includes('*') || keys.includes('shifts.manage');
  if (!openedByRequester && !sameTerminal && !isManager) {
    res.status(403).json({ error: 'Not your drawer' });
    return;
  }

  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20_000) : []);
  try {
    const orderIds = await fetchAllIds('orders', q => q.eq('shift_id', id).eq('status', 'completed'));
    // The till's sales carry its local id as idempotency_key (the cloud mints its own id) — fetch both.
    const keyed = orderIds.length
      ? await chunkIn<{ id: string; idempotency_key: string | null }>('orders', 'id', orderIds, q => q.select('id, idempotency_key'))
      : [];
    const keyById = new Map(keyed.map(o => [o.id, o.idempotency_key]));
    const payments = orderIds.length
      ? await chunkIn<{ order_id: string; method: string; status: string; amount: number }>(
          'payments', 'order_id', orderIds,
          q => q.select('order_id, method, status, amount').eq('method', 'cash').in('status', ['completed', 'refunded']))
      : [];
    const { data: floats }   = await supabase.from('float_transactions').select('id, type, amount').eq('shift_id', id);
    const { data: expenses } = await supabase.from('expenses').select('id, amount').eq('shift_id', id);
    // A342: other shifts open on this same till (the web standing in as it) — the till's count covers them too.
    const siblings = siblingSummary(await openSiblingCash(shift as any, req.businessId!));
    res.json({
      ...foreignCash(
        { orders: orderIds.map(o => ({ id: o, status: 'completed', idempotency_key: keyById.get(o) ?? null })), payments, floats: floats ?? [], expenses: expenses ?? [] },
        { order_ids: ids(req.body?.order_ids), float_ids: ids(req.body?.float_ids), expense_ids: ids(req.body?.expense_ids) },
      ),
      siblings,
    });
  } catch (e) { sendError(res, e as Error); }
});

// ──────────────────────────────────────────────────────────
// POST /api/shifts/:id/foreign-orders   body: { own_ids }
// Cross-sync stage 1 (2026-09-27): the SALES on this drawer the calling till did not
// ring — the web POS standing in for it — with their lines and payments, so the till
// can show them in its orders, shift and Z-report. Read-only; authorised exactly like
// foreign-cash (the opener, a cashier on the same terminal, or a manager).
// ──────────────────────────────────────────────────────────
router.post('/:id/foreign-orders', async (req, res) => {
  const { id } = req.params;
  const { data: shift } = await supabase
    .from('shifts').select('id, device_id, terminal_code, branch_id, opened_by, cashier_id')
    .eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }

  const sameTerminal =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') === terminalKeyFromRequest(req);
  const openedByRequester = shift.opened_by === req.userId || shift.cashier_id === req.userId;
  const keys = req.permissionKeys ?? [];
  const isManager = req.isOwner || keys.includes('*') || keys.includes('shifts.manage');
  if (!openedByRequester && !sameTerminal && !isManager) {
    res.status(403).json({ error: 'Not your drawer' });
    return;
  }

  const ownIds = Array.isArray(req.body?.own_ids)
    ? req.body.own_ids.filter((x: unknown): x is string => typeof x === 'string').slice(0, 20_000) : [];
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, order_number, order_type, status, subtotal, vat_amount, discount_amount, total, tip_amount,
        ctl_amount, covers, customer_id, customer_name, customer_phone, idempotency_key, cashier_id,
        shift_id, branch_id, created_at, void_reason, voided_at, voided_by, refunded_at,
        refunded_amount, refund_reason, delivery_person, notes,
        order_items ( id, product_id, product_name, category_name, unit_price, quantity, subtotal, course, fire_status, notes ),
        payments ( id, method, amount, amount_tendered, change_given, reference, status, created_at )
      `)
      .eq('shift_id', id)
      .eq('business_id', req.businessId)
      .in('status', ['completed', 'voided'])
      .order('created_at', { ascending: true })
      .limit(2000);
    if (error) throw error;
    res.json({ orders: foreignOrders((data ?? []) as unknown as CloudOrder[], ownIds) });
  } catch (e) { sendError(res, e as Error); }
});

router.post('/:id/close', validate(CloseShiftSchema), async (req, res) => {
  const { id } = req.params;
  const { closing_float, notes, denomination_breakdown, declared_methods } = req.body;
  // A365: every method the cashier declared; cash is always the counted drawer.
  const declared = declared_methods ? { ...(methodMap(declared_methods) ?? {}), cash: Number(closing_float) } : null;

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
  const isManager = callerMayConfirm(req);

  // A366 (owner, 2026-09-30): "only the shift owner can close the shift not any other cashier, maybe the manager should
  // be able to close it". The cashier who opened it, or a manager. "On the same terminal" no longer lets another cashier
  // count out someone else's drawer — EXCEPT the till's own replay (desktop, same till): the till enforced the owner rule
  // when the cashier counted (shiftService.closeShift), and it replays the close later under whoever is signed in then.
  const tillReplay = req.surface === 'desktop' && sameTerminal;
  if (!openedByRequester && !isManager && !tillReplay) {
    res.status(403).json({
      error: 'Only the cashier who opened this shift, or a manager, can close it.',
      code: 'SHIFT_NOT_YOURS',
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
  // A342: closed FROM THE TILL (a desktop token), the till's count also covers any other shift open on this same till —
  // the web POS standing in as it. Owner, 2026-09-27: "Till's count covers both". A web close never closes the till's.
  const siblings = req.surface === 'desktop' ? await openSiblingCash(shift, req.businessId!) : [];
  const siblingExpected = siblings.reduce((s2, x) => s2 + x.expected, 0);
  const expectedCash  = Number(shift.opening_float) + cashSales + floatIn - floatOut - expensesOut + siblingExpected;
  const cashVariance  = Number(closing_float) - expectedCash;

  // Require an explanatory note whenever the count doesn't match expected cash.
  //
  // A342: NOT for a till's close. The till already required a note against its own figures when the cashier counted;
  // this is the cloud replaying that close later (reconcileClosedShifts), and the web may have sold on the till's other
  // shift in between. Refusing it would make the till retry the close forever — the blocking A338 removed. Record the
  // difference and say where it came from instead.
  let closeNotes: string | null = notes ?? null;
  if (req.surface === 'desktop' && Math.round(cashVariance * 100) !== 0 && !(notes && notes.trim())) {
    closeNotes = 'Variance recorded when the till\'s close reached the cloud — figures on this till moved after the count.';
  } else if (Math.round(cashVariance * 100) !== 0 && !(notes && notes.trim())) {
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
      notes: closeNotes,
      denomination_breakdown: denomination_breakdown ?? null,
      ...(declared ? { declared_methods: declared } : {}),
    })
    .eq('id', id)
    .select()
    .single();

  if (closeErr) { sendError(res, closeErr); return; }

  // A342: the till's count closed the web's shift(s) on this till too — recorded as counted, inside that drawer, no variance.
  const tillLabel = shift.terminal_code || 'the till';
  for (const sib of siblings) {
    const { error: sibErr } = await supabase
      .from('shifts')
      .update({
        status: 'closed', closed_at: new Date().toISOString(), closed_by: req.userId, close_method: 'counted',
        closing_float: sib.expected, expected_cash: sib.expected, cash_variance: 0,
        notes: closedWithTillNote(tillLabel, id),
      })
      .eq('id', sib.id).eq('business_id', req.businessId).eq('status', 'open');
    if (sibErr) console.error('[shifts] A342 could not close sibling shift', sib.id, sibErr.message);
  }
  res.json({ ...closed, closed_with: siblings.map(x => x.id) });
});


// ─────────────────────────────────────────────────────────────────────────────
// A365 — a manager confirms a closed shift: a blind recount of every payment method.
//
// Three ways in, one record:
//   * the TILL replays a confirmation it took offline (desktop surface, same till, `confirmed_by` = the manager whose
//     PIN the till verified). The cloud re-checks that person may confirm; it does not see the PIN.
//   * a manager's PIN typed at the web POS (the cashier is signed in) — the refund rule's lookup, widened to mayConfirm.
//   * a manager signed in on the dashboard confirms as themselves.
// A second confirmation is refused (409 ALREADY_CONFIRMED) — the till treats that as done.
// ─────────────────────────────────────────────────────────────────────────────
async function confirmerRows(businessId: string) {
  const [{ data: rows }, { data: biz }] = await Promise.all([
    supabase
      .from('users')
      .select('id, name, pin_hash, override_pin_hash, roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) )')
      .eq('business_id', businessId)
      .eq('status', 'active'),
    supabase.from('businesses').select('owner_id').eq('id', businessId).maybeSingle(),
  ]);
  return { rows: (rows ?? []) as (ApproverRow & { name?: string | null })[], ownerId: ((biz as any)?.owner_id ?? null) as string | null };
}

async function confirmerByPin(businessId: string, pin: string, authorizerId?: string) {
  const { rows, ownerId } = await confirmerRows(businessId);
  const found = await findApprover(rows, { pin, authorizerId, ownerId, may: mayConfirm }, {
    loginPin:    async (p, h) => (await verifyPin(p, h, businessId)).valid,
    overridePin: (p, h) => bcrypt.compare(p, h),
  });
  if (found.result !== 'ok') return null;
  const row = rows.find((r) => r.id === found.userId);
  return { id: found.userId, name: row?.name ?? null };
}

/** What the system recorded per payment method on a closed shift; cash = the stored expected cash in the drawer. */
async function expectedByMethod(shift: { id: string; expected_cash?: number | string | null; opening_float?: number | string | null }): Promise<MethodMap> {
  const out: MethodMap = {};
  const orderIds = await fetchAllIds('orders', q => q.eq('shift_id', shift.id).eq('status', 'completed'));
  if (orderIds.length) {
    const pays = await chunkIn<{ method: string; amount: number | string }>(
      'payments', 'order_id', orderIds,
      q => q.select('method, amount').in('status', ['completed', 'refunded']),
    );
    for (const p of pays) {
      const m = String(p.method ?? '').trim().toLowerCase();
      if (!m || m === 'cash') continue;
      out[m] = Math.round(((out[m] ?? 0) + Number(p.amount)) * 100) / 100;
    }
  }
  out.cash = shift.expected_cash != null
    ? Number(shift.expected_cash)
    : await computeExpectedCash(shift.id, Number(shift.opening_float) || 0);
  return out;
}

// POST /api/shifts/confirmer — the till asks who a manager's PIN belongs to (the till then confirms locally and syncs).
router.post('/confirmer', async (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (!pin) { res.status(400).json({ error: 'Enter the manager\'s PIN.' }); return; }
  const who = await confirmerByPin(req.businessId!, pin, req.body?.authorizer_id || undefined);
  if (!who) {
    res.status(403).json({ error: 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.', code: 'INVALID_CONFIRMER_PIN' });
    return;
  }
  res.json(who);
});

// POST /api/shifts/:id/confirm
router.post('/:id/confirm', async (req, res) => {
  const { id } = req.params;
  const counts = methodMap(req.body?.confirmed_methods);
  if (!counts) { res.status(400).json({ error: 'Enter the counted amount for every payment method.' }); return; }

  const { data: shift, error } = await supabase
    .from('shifts').select('*').eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return; }
  if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }
  if (shift.status === 'open') { res.status(409).json({ error: 'The cashier has not closed this shift yet.', code: 'SHIFT_OPEN' }); return; }
  if (shift.confirmed_at) { res.status(409).json({ error: 'This shift is already confirmed.', code: 'ALREADY_CONFIRMED' }); return; }

  let confirmer: { id: string; name: string | null } | null = null;
  let at = new Date().toISOString();
  let expected: MethodMap | null = null;
  const sameTill =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') === terminalKeyFromRequest(req);

  if (req.surface === 'desktop' && typeof req.body?.confirmed_by === 'string') {
    // The till's replay: its manager was verified by PIN on the till.
    if (!sameTill) { res.status(403).json({ error: 'Only the till that holds this shift can send its confirmation.' }); return; }
    const { rows, ownerId } = await confirmerRows(req.businessId!);
    const row = rows.find((r) => r.id === req.body.confirmed_by);
    if (!row || !mayConfirm(row, ownerId)) {
      res.status(403).json({ error: 'The person who confirmed this shift may not confirm shifts.', code: 'NOT_A_CONFIRMER' });
      return;
    }
    confirmer = { id: row.id, name: row.name ?? null };
    at = replayTime(req.body?.confirmed_at);
    expected = methodMap(req.body?.expected_methods);
  } else if (req.body?.pin) {
    confirmer = await confirmerByPin(req.businessId!, String(req.body.pin), req.body?.authorizer_id || undefined);
    if (!confirmer) {
      res.status(403).json({ error: 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.', code: 'INVALID_CONFIRMER_PIN' });
      return;
    }
  } else if (callerMayConfirm(req)) {
    confirmer = { id: req.userId!, name: null };
  } else {
    res.status(403).json({ error: 'A manager must confirm this shift — enter a manager\'s PIN.', code: 'CONFIRMER_REQUIRED' });
    return;
  }

  if (!expected) {
    try { expected = await expectedByMethod(shift); } catch (e) { sendError(res, e as Error); return; }
  }
  const self = isSelfConfirm(confirmer.id, shift);
  const { data: updated, error: upErr } = await supabase
    .from('shifts')
    .update({ confirmed_methods: counts, expected_methods: expected, confirmed_by: confirmer.id, confirmed_at: at, confirm_self: self })
    .eq('id', id).eq('business_id', req.businessId).is('confirmed_at', null)
    .select().maybeSingle();
  if (upErr) { sendError(res, upErr); return; }
  if (!updated) { res.status(409).json({ error: 'This shift is already confirmed.', code: 'ALREADY_CONFIRMED' }); return; }
  res.json({
    ...updated,
    confirmer_name: confirmer.name,
    lines: confirmationLines(methodMap(shift.declared_methods), expected, counts),
  });
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
/**
 * A342: the other shifts open on the same till as `shift`, with the cash each should hold. Empty for a closed shift.
 * Declared as a function (hoisted) so the routes above can use it.
 */
async function openSiblingCash(shift: { id: string; status: string; business_id?: string; device_id?: string | null; terminal_code?: string | null; branch_id?: string | null }, businessId: string): Promise<SiblingCash[]> {
  if (shift.status !== 'open') return [];
  const { data: open } = await supabase
    .from('shifts').select('id, status, device_id, terminal_code, branch_id, opening_float, opened_at, opened_by, cashier_id')
    .eq('business_id', businessId).eq('status', 'open');
  const sibs = siblingsOf(shift, (open ?? []) as any[]);
  if (!sibs.length) return [];
  const ids = [...new Set(sibs.map((x: any) => x.opened_by ?? x.cashier_id).filter(Boolean))] as string[];
  const { data: users } = ids.length ? await supabase.from('users').select('id, name').in('id', ids) : { data: [] as any[] };
  const nameById = new Map((users ?? []).map((u: any) => [u.id, u.name]));
  const out: SiblingCash[] = [];
  for (const x of sibs as any[]) {
    out.push({ id: x.id, opened_by_name: nameById.get(x.opened_by ?? x.cashier_id) ?? null, opened_at: x.opened_at ?? null,
               expected: await computeExpectedCash(x.id, Number(x.opening_float) || 0) });
  }
  return out;
}

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
// POST /api/shifts/:id/expense
// A362 (2026-09-28, owner: "web pos cannot record expences on cashier"): petty cash paid out of an open drawer, recorded
// from the web POS — the web twin of the till's Shift → Expenses, which any signed-in cashier may use. Same rule as a
// float above (an open shift of this business, no key): the cash leaves THIS drawer, so it is the drawer's record, and the
// shift's expected cash (and the till's count, A334 foreign cash) subtracts it. The back office's POST /api/expenses
// (any date, any branch, a chosen Paid By) stays expenses.manage.
// paid_by and recorded_by (A361) are both the signed-in person — at the till they are the same person too.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/expense', async (req, res) => {
  const { id } = req.params;
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const amount = Number(req.body?.amount);
  const categoryId = typeof req.body?.expense_category_id === 'string' && req.body.expense_category_id
    ? req.body.expense_category_id : null;

  if (!description) { res.status(400).json({ error: 'Say what the money was for (description).' }); return; }
  if (description.length > 255) { res.status(400).json({ error: 'Description is too long (255 characters at most).' }); return; }
  if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ error: 'Enter an amount greater than zero.' }); return; }

  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('id, branch_id, status')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .maybeSingle();
  if (shiftErr) { sendError(res, shiftErr); return; }
  if (!shift) { res.status(404).json({ error: 'Open shift not found' }); return; }

  if (categoryId) {
    const { data: cat } = await supabase.from('expense_categories').select('id')
      .eq('id', categoryId).eq('business_id', req.businessId).maybeSingle();
    if (!cat) { res.status(400).json({ error: 'That expense type no longer exists — pick another.' }); return; }
  }

  const who = await recorderId(req);
  const { data, error } = await supabase
    .from('expenses')
    .insert({
      business_id:         req.businessId,
      branch_id:           (shift as { branch_id: string }).branch_id,
      shift_id:            id,
      expense_category_id: categoryId,
      description,
      amount,
      paid_by:             who,
      recorded_by:         who,
      expense_date:        new Date().toISOString().slice(0, 10),   // as the till and POST /api/expenses do
    })
    .select('id, description, amount, expense_date, expense_category_id, created_at')
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
  // A365: the confirming manager's name too.
  const cashierIds = [...new Set([...shifts.map(s => s.cashier_id), ...shifts.map(s => s.confirmed_by).filter(Boolean)])];
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
    confirmer_name: s.confirmed_by ? (nameMap[s.confirmed_by] ?? null) : null,
    // A365: closed under the new rule (declared every method) and not yet confirmed by a manager.
    awaiting_confirmation: s.status !== 'open' && s.declared_methods != null && s.confirmed_at == null,
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
      .select('id, total, created_at, payments ( method, amount, status )')
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

  // A262: payment breakdown + cash reconciliation for the shift report (byMethod,
  // cash sales, float in/out, live expected cash) — the figures the desktop
  // Z-report shows. Only completed payments count toward the drawer.
  const byMethodMap: Record<string, { orders: number; amount: number }> = {};
  let cashSales = 0;
  (orders ?? []).forEach((o: any) => {
    (o.payments ?? []).forEach((pm: { method: string; amount: string; status: string }) => {
      if (pm.status && pm.status !== 'completed') return;
      const method = pm.method ?? 'other';
      (byMethodMap[method] ??= { orders: 0, amount: 0 });
      byMethodMap[method].orders += 1;
      byMethodMap[method].amount += Number(pm.amount);
      if (method === 'cash') cashSales += Number(pm.amount);
    });
  });
  const byMethod = Object.entries(byMethodMap).map(([method, v]) => ({ method, orders: v.orders, amount: v.amount }));
  let floatIn = 0, floatOut = 0;
  (floatTxns ?? []).forEach((f: { type: string; amount: string }) => {
    if (f.type === 'float_in') floatIn += Number(f.amount);
    else if (f.type === 'float_out') floatOut += Number(f.amount);
  });
  const expectedCash = Number(shift.opening_float) + cashSales + floatIn - floatOut;

  res.json({
    ...shift,
    cashier_name: cashier?.name ?? 'Unknown',
    float_transactions: floatTxns ?? [],
    order_count: (orders ?? []).length,
    total_revenue: totalRevenue,
    by_method: byMethod,
    cash_sales: cashSales,
    float_in: floatIn,
    float_out: floatOut,
    expected_cash_computed: expectedCash,
  });
});

export default router;
