import { Router, type Request, type Response } from 'express';
import { branchScope, requirePermission, can, assertBranchAccess, branchFilter, byBranch, inBranchSet, oneBranchOnly, NO_BRANCH } from '../middleware/rbac';
import { pinKey, pinLocked, notePinFailure, notePinSuccess, PIN_LOCKED_BODY } from '../lib/pinAttempts';   // A494
import { mayMoveMoney } from '../lib/historyScope';   // A490
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
import { foreignCash, foreignOrders, ownReversals } from '../lib/foreignCash';
import { readShift, shiftOrdersFor } from '../lib/shiftOrdersMemo';   // A591
import { quietMemo } from '../lib/quietMemo';   // A593
/** A593: GET /state's rows and names per (business, the ids asked) — lib/quietMemo.ts. */
const stateMemo = quietMemo<{ rows: unknown[]; names: Record<string, string> }>('shifts.state');
import { recorderId } from '../lib/expenseRecorder';
import { cleanExpenseMethod, nonCashExpenses } from '@zaptill/core/expenseMethod';
import { reasonsNeeded, cleanReasons, missingReasons } from '@zaptill/core/confirmReasons';
import { businessPosFeatures } from '../lib/posFeatureFlags';
import { CASH_MOVEMENT_REASON_REQUIRED, DRAWER_COUNT_WARNING, DRAWER_COUNT_CODE, cashMovementNeedsApprover, looksLikeDrawerCount } from '@zaptill/core/posFeatures';   // A594
import { siblingsOf, siblingSummary, closedWithTillNote, type SiblingCash } from '../lib/siblingDrawers';
import { mayConfirm, callerMayConfirm, methodMap, confirmationLines, isSelfConfirm, replayTime, cashBreakdown, type MethodMap } from '../lib/shiftConfirm';
import { confirmerRows, confirmerByPin, SELF_APPROVAL_BODY, NO_CONFIRMER_BODY } from '../lib/confirmerLookup';
import { payoutApprover } from '../lib/payoutApproval';   // 0.6.37 (A388)
import { buildBranchReport, type BranchOrder, type BranchShift, type TillName } from '../lib/branchReport';
import { orderTax } from '../lib/orderTax';
import { buildShiftZReport, shiftByCashier } from '../lib/shiftZReport';
import { cashierSeesShiftSales } from '../lib/cashierShiftSales';   // A416
import { businessDateEAT } from '@zaptill/core/businessDay';
import { getDayCutoff } from '../lib/dayCutoff';
import { notifyOwner, kes } from '../lib/ownerNotice';   // A522

const router = safeRouter();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/current
// Returns the caller's open shift for their branch (if any).
// Used by the POS on boot to resume a session.
// ─────────────────────────────────────────────────────────────────────────────
/** A494: a drawer of another branch is refused to a non-owner (the business was checked by the read). */
function notThisBranch(req: Request, res: Response, shift: { branch_id?: string | null } | null | undefined): boolean {
  if (assertBranchAccess(req, shift?.branch_id ?? null)) return false;
  res.status(403).json({ error: 'You do not have access to this branch' });
  return true;
}

/**
 * A494: may this caller see a drawer's figures — expected cash, the difference, what was declared and confirmed? Someone
 * holding reports.shifts or shifts.confirm (the owner always) — never a till's own session (no person). The drawer's own
 * cashier keeps the blind rules of their own drawer (GET /:id below, 'blind_shift_close').
 */
function seesDrawerFigures(req: Request): boolean {
  return !req.isTill && can(req, 'reports.shifts', 'shifts.confirm');
}
const DRAWER_FIGURES = ['expected_cash', 'expected_cash_live', 'expected_cash_computed', 'cash_variance', 'closing_float',
  'declared_methods', 'expected_methods', 'confirmed_methods', 'denomination_breakdown', 'confirm_reasons',
  'till_counted_cash', 'till_confirmed_methods'] as const;   // A522: the till's own count after a web close is a figure too
const withoutFigures = (row: Record<string, any>): Record<string, any> => {
  const out = { ...row };
  for (const k of DRAWER_FIGURES) delete out[k];
  return out;
};
/** A582: a partner (lib/webPartners.ts) reads a branch's tills and drawers only when it is theirs — a branch named in the
 *  query was taken as it came (a partner of X, Y and Z could name W). Everyone else exactly as before. */
const partnerOutside = (req: Request, branchId: string | null | undefined): boolean =>
  req.webPartner === true && !assertBranchAccess(req, branchId ?? null);
// A582: the tills and drawers of a branch named in the query (/terminals, /terminals/open, /web-till) — a partner's own
// branches only; everyone else as before.
router.use(['/terminals', '/web-till'], (req, res, next) => {
  const asked = typeof req.query.branch_id === 'string' ? req.query.branch_id.trim() : '';
  if (asked && partnerOutside(req, asked)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  next();
});
const ownDrawer = (req: Request, s: { cashier_id?: string | null; opened_by?: string | null }): boolean =>
  !!req.userId && (s.cashier_id === req.userId || s.opened_by === req.userId);

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
// GET /api/shifts/state?ids=a,b — A401: where the cloud says these shifts stand.
//
// Owner, 2026-10-05: "force close drawer on the web does not close desktop till it remains open". A till never asked:
// its drawer stayed open after a manager force-closed (or closed) it on the web, and the till kept selling against a
// shift the cloud had ended. The till now sends the ids of its open shifts on its ~20 s beat; each one the cloud has
// closed comes back with how (and by whom), and the till closes it locally the same way (syncEngine.adoptCloudCloses).
// Read-only. Only this business's shifts; unknown ids are left out (a shift not yet pushed is not "closed").
// ─────────────────────────────────────────────────────────────────────────────
router.get('/state', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map((x) => x.trim())
    .filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
  if (!ids.length) { res.json([]); return; }
  // A593: the drawers' rows and their closers' names, kept while nothing is written for the business (a close, a force
  // close, a confirmation — a POS's or the web's — all come through this server; ≤ 5 minutes for a change made in SQL).
  // The POS asks every 20 s and the answer is almost always the same. The partner filter below runs on every ask.
  type StateRow = { id: string; branch_id?: string | null; status: string; closed_by: string | null; [k: string]: unknown };
  const memoKey = ids.join(',');
  let kept = stateMemo.get(req.businessId!, memoKey);
  if (!kept) {
    const mark = stateMemo.mark(req.businessId!);
    const { data, error } = await supabase.from('shifts')
      // A433: and the confirmation — a shift confirmed on the web or another till is confirmed on the till that holds it.
      .select('id, branch_id, status, closed_at, close_method, closed_by, closing_float, cash_variance, expected_cash, notes, confirmed_at, confirmed_by, confirmed_methods, expected_methods, confirm_reasons, confirm_self')
      .eq('business_id', req.businessId).in('id', ids);
    if (error) { sendError(res, error); return; }
    const all = (data ?? []) as StateRow[];
    const everyCloser = [...new Set(all.flatMap((r) => [r.closed_by, r.confirmed_by as string | null]).filter((x): x is string => !!x))];
    const nameOf: Record<string, string> = {};
    if (everyCloser.length) {
      const { data: us, error: uErr } = await supabase.from('users').select('id, name').in('id', everyCloser);
      for (const u of (us ?? []) as Array<{ id: string; name: string | null }>) nameOf[u.id] = u.name ?? '';
      if (uErr) { kept = { rows: all, names: nameOf }; }   // answered as before (names missing), never kept
    }
    if (!kept) { kept = { rows: all, names: nameOf }; stateMemo.set(req.businessId!, memoKey, kept, mark); }
  }
  // A582: a partner gets only the drawers of their branches (the ids came from the caller)
  const rows = (kept.rows as StateRow[]).filter((r) => !partnerOutside(req, r.branch_id));
  const names = new Map<string, string>(Object.entries(kept.names));
  res.json(rows.map((r) => ({
    ...r,
    closed_by_name: r.closed_by ? names.get(r.closed_by) || null : null,
    confirmed_by_name: r.confirmed_by ? names.get(r.confirmed_by as string) || null : null,
  })));
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
  // A494: a branch of this business, and one the caller works at (the owner: any of theirs).
  if (!assertBranchAccess(req, branch_id)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  {
    const { data: br, error: bErr } = await supabase.from('branches').select('id').eq('id', branch_id).eq('business_id', req.businessId).maybeSingle();
    if (bErr) { sendError(res, bErr); return; }
    if (!br) { res.status(400).json({ error: 'That branch is not one of this business\u2019s', code: 'BRANCH_NOT_FOUND' }); return; }
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

  // P2-15: the shift's business date (the business's "day ends at" cut-off, the branch's own wins) — the monthly pack and
  // every report by business date find a web shift as they find a till's.
  const cutoff = await getDayCutoff(req.businessId, branch_id);
  const openRow: Record<string, unknown> = {
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
    business_date: businessDateEAT(new Date(), cutoff),
    // P0-1 (migration 133): this drawer was opened on the WEB. Only such a drawer is closed with a till's count (A342).
    opened_via: 'web',
  };
  let { data, error } = await supabase.from('shifts').insert(openRow).select().single();
  // Before migration 133 the column is not there: open the drawer without it (the sibling rule then reads business_day_id).
  if (error && /opened_via/.test(error.message ?? '')) {
    const { opened_via: _v, ...withoutVia } = openRow;
    // business_id: forced from the token in openRow above
    ({ data, error } = await supabase.from('shifts').insert(withoutVia).select().single());
  }

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
  const { data: shift, error: shiftErr } = await supabase
    .from('shifts').select('id, status, device_id, terminal_code, branch_id, opened_by, cashier_id')
    .eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (shiftErr) { sendError(res, shiftErr); return; }   // P1-4: a failed read is not "no such shift"
  if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }
  if (notThisBranch(req, res, shift)) return;   // A494

  const sameTerminal =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') === terminalKeyFromRequest(req);
  const openedByRequester = !!req.userId && (shift.opened_by === req.userId || shift.cashier_id === req.userId);
  // A490: a manager is shifts.confirm (what shifts.manage stood for); checked last, so the till's own drawer is not logged.
  if (!openedByRequester && !sameTerminal && !can(req, 'shifts.confirm')) {
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
    const { data: floats, error: fErr }   = await supabase.from('float_transactions').select('id, type, amount').eq('shift_id', id);
    if (fErr) throw new Error(`foreign-cash floats: ${fErr.message}`);   // P1-4: never a 0 for a failed read
    // 0.6.27: only a cash expense is out of the drawer (migration 111: payment_method, default 'cash').
    const { data: expenses, error: eErr } = await supabase.from('expenses').select('id, amount').eq('shift_id', id).eq('payment_method', 'cash');
    if (eErr) throw new Error(`foreign-cash expenses: ${eErr.message}`);
    // A342: other shifts open on this same till that the WEB opened standing in as it — the till's count covers them too.
    const siblings = siblingSummary(await openSiblingCash(shift as any, req.businessId!, tillCloseTime(req, null)));
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
  // A591: the drawer and its sales from lib/shiftOrdersMemo.ts — only what changed is read, only the sales the answer can
  // hold are read in full, nothing at all while nothing was written (the till asks every ~20 s).
  const shift = await readShift(req.businessId, id);
  if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }
  if (notThisBranch(req, res, shift)) return;   // A494

  const sameTerminal =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') === terminalKeyFromRequest(req);
  const openedByRequester = !!req.userId && (shift.opened_by === req.userId || shift.cashier_id === req.userId);
  // A490: a manager is shifts.confirm (what shifts.manage stood for); checked last, so the till's own drawer is not logged.
  if (!openedByRequester && !sameTerminal && !can(req, 'shifts.confirm')) {
    res.status(403).json({ error: 'Not your drawer' });
    return;
  }

  const ownIds = Array.isArray(req.body?.own_ids)
    ? req.body.own_ids.filter((x: unknown): x is string => typeof x === 'string').slice(0, 20_000) : [];
  try {
    const rows = await shiftOrdersFor(req.businessId, id, shift, ownIds);
    // 0.6.26 (A336 follow-up): also which of the till's OWN sales were voided or refunded here (on the web). An older till
    // ignores the field.
    res.json({ orders: foreignOrders(rows, ownIds), own_reversals: ownReversals(rows, ownIds) });
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

  // Fetch the shift (must belong to this business and be open).
  // P1-3: three different answers, never one 404 for all of them — the till marks its close synced on 2xx or 409
  // ALREADY_CLOSED only, so a database hiccup (5xx) is retried and a shift that is really gone (404) is flagged.
  // A522: the till's own count of a drawer the web closed first is kept (recordTillCount), never dropped with the 409.
  const found = await openShiftOr409(req, res, id, (closedShift) => recordTillCount(req, closedShift));
  if (!found) return;
  const shift = found;
  if (notThisBranch(req, res, shift)) return;   // A494

  // ── Authorisation (finding #13) ──────────────────────────────────────────
  // Previously ANY authenticated user in the business could close ANY drawer,
  // from any terminal, with any cash count — a fraud vector and a data-integrity
  // hole (a stranger's count lands on a drawer they never touched). A drawer may
  // be closed by:
  //   * the cashier who opened it (opened_by / cashier_id), or
  //   * a cashier physically on that same terminal (they share the session), or
  //   * a manager (A490: shifts.confirm — callerMayConfirm).
  const sameTerminal =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '')
      === terminalKeyFromRequest(req);
  const openedByRequester = !!req.userId && (shift.opened_by === req.userId || shift.cashier_id === req.userId);
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

  // 0.6.28 ('kitchen_void_approval'): not while an order sent to the kitchen on this shift is unpaid — it is charged, or a
  // manager voids its items (POST /api/orders/:id/kitchen-void). A till's own close is checked on the till (its ledger),
  // and its replay is never refused for it (refusing would make the till retry forever).
  // A461: unless the client has 'pay_later_tabs' (eat now, pay later — the order stays open until it is charged).
  // A522 (owner, 2026-10-17: "nothing may wait on a till that is switched off"): the owner, or a holder of shifts.close_day,
  // may go ahead from the web with `ack_unpaid` — the till holding those orders may be off. The close is noted with them;
  // they stay open (charged or voided on the till when it is back). Everyone else is refused as before.
  let unpaidNote: string | null = null;
  if (!tillReplay && !(await businessPosFeatures(req.businessId!)).pay_later_tabs) {
    const { data: unpaid } = await supabase.from('orders').select('order_number')
      .eq('business_id', req.businessId).eq('shift_id', id).eq('status', 'open').limit(20);
    if ((unpaid ?? []).length) {
      const list = (unpaid ?? []).slice(0, 4).map((o: { order_number: string }) => `#${o.order_number}`).join(', ');
      const mayOverride = !req.isTill && (req.isOwner === true || can(req, 'shifts.close_day'));
      if (mayOverride && req.body?.ack_unpaid === true) {
        unpaidNote = `Closed on the web with ${unpaid!.length} unpaid kitchen order${unpaid!.length === 1 ? '' : 's'} still open (${list}) — they stay open on the POS.`;
      } else {
        res.status(409).json({
          error: `${unpaid!.length} order${unpaid!.length === 1 ? ' was' : 's were'} sent to the kitchen and not paid (${list}). ` +
                 'Charge them, or have a manager void them, before ending the shift.',
          code: 'UNPAID_KITCHEN_ORDERS',
          orders: (unpaid ?? []).map((o: { order_number: string }) => o.order_number),
          may_override: mayOverride,
        });
        return;
      }
    }
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

  // P2-11: when the drawer was counted — the till's own time (it replays the close later), else now.
  const closeAt = tillCloseTime(req, shift.opened_at ?? null);
  const closedBy = await tillClosedBy(req);

  // Sum float_out movements (cash removed from drawer). P1-4: a failed read is a 5xx, never a 0 stored for good.
  let floatIn = 0, floatOut = 0, expensesOut = 0;
  let siblings: SiblingCash[] = [];
  try {
    ({ floatIn, floatOut } = await shiftFloats(id));
    expensesOut = await shiftExpenses(id);
    // A342: closed FROM THE TILL (a desktop token), the till's count also covers the shift the WEB POS opened standing in
    // as this till, opened before the count. Owner, 2026-09-27: "Till's count covers both". A web close never closes the
    // till's, and the till's own next drawer is never folded in (P0-1).
    if (req.surface === 'desktop') siblings = await openSiblingCash(shift as any, req.businessId!, closeAt);
  } catch (e) { sendError(res, e as Error); return; }
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
    closeNotes = 'Variance recorded when the POS\'s close reached the cloud — figures on this POS moved after the count.';
  } else if (Math.round(cashVariance * 100) !== 0 && !(notes && notes.trim())
             // 0.6.27: a blind close ('blind_shift_close', a cashier) — they could not see the variance; the manager
             // explains it at confirmation.
             && !(!callerMayConfirm(req) && (await businessPosFeatures(req.businessId)).blind_shift_close)) {
    res.status(400).json({
      error: 'A note is required to close a shift with a cash variance',
      variance: cashVariance,
      expected_cash: expectedCash,
    });
    return;
  }
  if (unpaidNote) closeNotes = [closeNotes, unpaidNote].filter(Boolean).join('\n');   // A522

  const { data: closed, error: closeErr } = await supabase
    .from('shifts')
    .update({
      status: 'closed',
      closed_at: closeAt,
      closed_by: closedBy,
      close_method: 'counted',
      closing_float: Number(closing_float),
      expected_cash: expectedCash,
      cash_variance: cashVariance,
      notes: closeNotes,
      denomination_breakdown: denomination_breakdown ?? null,
      ...(declared ? { declared_methods: declared } : {}),
    })
    .eq('id', id)
    .eq('business_id', req.businessId)
    // Conditional: a close racing another close (or a force-close) never overwrites the one that landed first.
    .eq('status', 'open')
    .select()
    .maybeSingle();

  if (closeErr) { sendError(res, closeErr); return; }
  if (!closed) { await alreadyClosed(req, res, id); return; }

  // A342: the till's count closed the web's shift(s) on this till too — recorded as counted, inside that drawer, no variance.
  const tillLabel = shift.terminal_code || 'the POS';
  for (const sib of siblings) {
    const { error: sibErr } = await supabase
      .from('shifts')
      .update({
        status: 'closed', closed_at: closeAt, closed_by: closedBy, close_method: 'counted',
        closing_float: sib.expected, expected_cash: sib.expected, cash_variance: 0,
        notes: closedWithTillNote(tillLabel, id),
      })
      .eq('id', sib.id).eq('business_id', req.businessId).eq('status', 'open');
    if (sibErr) console.error('[shifts] A342 could not close sibling shift', sib.id, sibErr.message);
  }
  // 0.6.27 ('blind_shift_close'): a cashier's close hands back no expected cash or variance — a manager checks them.
  // A415: the till's own replay of a close is not a cashier looking — the till already holds its figures.
  if (!isManager && !req.isTill && (await businessPosFeatures(req.businessId)).blind_shift_close) {
    res.json({ ...closed, expected_cash: null, cash_variance: null, blind: true, closed_with: siblings.map(x => x.id) });
    return;
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
// confirmerRows / confirmerByPin live in lib/confirmerLookup.ts (0.6.28: the web's kitchen voids use them too).

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
  // 0.6.27: an expense paid by M-Pesa (or another method) comes off that method's expected total — as on the till.
  const { data: spentRows, error: spentErr } = await supabase.from('expenses').select('amount, payment_method')
    .eq('shift_id', shift.id).neq('payment_method', 'cash');
  if (spentErr) throw new Error(`shift expenses by method: ${spentErr.message}`);   // P1-4
  for (const [m, v] of Object.entries(nonCashExpenses(spentRows ?? []))) out[m] = Math.round(((out[m] ?? 0) - v) * 100) / 100;
  out.cash = shift.expected_cash != null
    ? Number(shift.expected_cash)
    : await computeExpectedCash(shift.id, Number(shift.opening_float) || 0);
  return out;
}

// POST /api/shifts/confirmer — the till asks who a manager's PIN belongs to (the till then confirms locally and syncs).
router.post('/confirmer', async (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (!pin) { res.status(400).json({ error: 'Enter the manager\'s PIN.' }); return; }
  const key = pinKey(req);   // A494: it names whose PIN it is — behind the one PIN limiter
  if (pinLocked(key)) { res.status(429).json(PIN_LOCKED_BODY); return; }
  // A494: someone at the caller's branch, never the caller themselves.
  const who = await confirmerByPin(req.businessId!, pin, req.body?.authorizer_id || undefined, { branchId: req.branchId ?? null, actorId: req.userId ?? null });
  if (who === 'self') { res.status(403).json(SELF_APPROVAL_BODY); return; }   // A505: their own PIN — no strike
  if (who === 'none') { res.status(400).json(NO_CONFIRMER_BODY); return; }   // A518: nobody here holds a PIN — no strike
  if (!who) {
    notePinFailure(key);
    res.status(403).json({ error: 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.', code: 'INVALID_CONFIRMER_PIN' });
    return;
  }
  notePinSuccess(key);
  res.json(who);
});

// POST /api/shifts/:id/confirm
async function confirmShiftRoute(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const counts = methodMap(req.body?.confirmed_methods);
  if (!counts) { res.status(400).json({ error: 'Enter the counted amount for every payment method.' }); return; }

  const { data: shift, error } = await supabase
    .from('shifts').select('*').eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return; }
  if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }
  if (notThisBranch(req, res, shift)) return;   // A494
  if (shift.status === 'open') { res.status(409).json({ error: 'The cashier has not closed this shift yet.', code: 'SHIFT_OPEN' }); return; }
  if (shift.confirmed_at) {
    // A522: the till's own confirmation, made while it was off, is kept when it differs — never dropped with the 409.
    let kept = false;
    try { kept = await recordTillConfirmation(req, shift as Record<string, any>, counts); } catch (e) { console.error('[shifts] A522', (e as Error)?.message ?? e); }
    res.status(409).json({ error: 'This shift is already confirmed.', code: 'ALREADY_CONFIRMED', ...(kept ? { till_count_recorded: true } : {}) });
    return;
  }

  let confirmer: { id: string; name: string | null } | null = null;
  let at = new Date().toISOString();
  let expected: MethodMap | null = null;
  const sameTill =
    terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') === terminalKeyFromRequest(req);

  if (req.surface === 'desktop' && typeof req.body?.confirmed_by === 'string') {
    // The till's replay: its manager was verified by PIN on the till.
    if (!sameTill) { res.status(403).json({ error: 'Only the POS that holds this shift can send its confirmation.' }); return; }
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
    const key = pinKey(req);   // A494: the one PIN limiter
    if (pinLocked(key)) { res.status(429).json(PIN_LOCKED_BODY); return; }
    const found = await confirmerByPin(req.businessId!, String(req.body.pin), req.body?.authorizer_id || undefined,
      { branchId: shift.branch_id ?? null, actorId: req.userId ?? null });   // A494
    // A505: the asker's own PIN — someone else must confirm; not a wrong guess (no strike towards the PIN lock).
    if (found === 'self') { res.status(403).json(SELF_APPROVAL_BODY); return; }
    if (found === 'none') { res.status(400).json(NO_CONFIRMER_BODY); return; }   // A518: nobody at the branch holds a PIN — no strike
    confirmer = found;
    if (!confirmer) {
      notePinFailure(key);
      res.status(403).json({ error: 'That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.', code: 'INVALID_CONFIRMER_PIN' });
      return;
    }
    notePinSuccess(key);
  } else if (callerMayConfirm(req)) {
    confirmer = { id: req.userId!, name: null };
  } else {
    res.status(403).json({ error: 'A manager must confirm this shift — enter a manager\'s PIN.', code: 'CONFIRMER_REQUIRED' });
    return;
  }

  if (!expected) {
    try { expected = await expectedByMethod(shift); } catch (e) { sendError(res, e as Error); return; }
  }
  // 0.6.27 ('confirm_shows_cashier_figures'): a reason for every method counted differently from the cashier. A till's
  // replay already enforced it (and is never refused for it — refusing would make the till retry forever).
  const declaredMap = methodMap(shift.declared_methods);
  const needed = reasonsNeeded(declaredMap, counts);
  const reasons = cleanReasons(req.body?.confirm_reasons, needed);
  if (req.surface !== 'desktop' && (await businessPosFeatures(req.businessId)).confirm_shows_cashier_figures) {
    const missing = missingReasons(needed, reasons);
    if (missing.length) {
      res.status(400).json({ error: `Give a reason where your count differs from the cashier's: ${missing.join(', ')}.`, code: 'REASON_REQUIRED', missing });
      return;
    }
  }
  const self = isSelfConfirm(confirmer.id, shift);
  const { data: updated, error: upErr } = await supabase
    .from('shifts')
    .update({ confirmed_methods: counts, expected_methods: expected, confirmed_by: confirmer.id, confirmed_at: at, confirm_self: self,
              confirm_reasons: reasons })
    .eq('id', id).eq('business_id', req.businessId).is('confirmed_at', null)
    .select().maybeSingle();
  if (upErr) { sendError(res, upErr); return; }
  if (!updated) { res.status(409).json({ error: 'This shift is already confirmed.', code: 'ALREADY_CONFIRMED' }); return; }
  res.json({
    ...updated,
    confirmer_name: confirmer.name,
    lines: confirmationLines(declaredMap, expected, counts).map((l) => (reasons?.[l.method] ? { ...l, reason: reasons[l.method] } : l)),
  });
}
router.post('/:id/confirm', confirmShiftRoute);
// A433 (owner, 2026-10-10: "yes if they have logged in as the manager"): a manager on ANOTHER till confirms as
// themselves — the same rules, never the replay (`confirmed_by` is the holding till's alone). Its own path, so the
// till's device token can never reach it (lib/terminalWrites.ts MANAGER_WRITES: a person's sign-in only).
router.post('/:id/manager-confirm', async (req, res) => {
  if (req.body && typeof req.body === 'object') delete req.body.confirmed_by;
  await confirmShiftRoute(req, res);
});

// GET /api/shifts/:id/confirm-view — 0.6.27: may the web's confirm screen show the cashier's figures
// ('confirm_shows_cashier_figures')? The declaration is the cashier's own figures (never the expected ones), so whoever
// holds the screen for the confirming manager may read it.
router.get('/:id/confirm-view', async (req, res) => {
  const showCashier = (await businessPosFeatures(req.businessId)).confirm_shows_cashier_figures;
  const { data: found } = await supabase.from('shifts').select('id, branch_id, declared_methods, expected_cash, opening_float, closing_float')
    .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  const shift = found && !partnerOutside(req, (found as any).branch_id) ? found : null;   // A582: another branch's: nothing
  // A452 (owner, 2026-10-12): "while confirming a shift let the manager see what the system holds … so that he can get
  // the variance before confirming". The expected figures go to a person who may confirm (a manager, the owner) only —
  // never to a cashier holding the screen.
  const expected = shift && callerMayConfirm(req) ? await expectedByMethod(shift as any) : null;
  // A527 (owner, 2026-10-17): "a manager when closing should see 4 items — opening float, cash sold, cash sold + float,
  // what the cashier keyed in". With the expected figures only (the same gate); `other` = cash in/out and cash expenses,
  // so the lines always add up to the expected cash.
  const cash = shift && expected ? cashBreakdown(Number((shift as any).opening_float) || 0, await shiftCashSales(String((shift as any).id)),
    Number(expected.cash ?? 0), methodMap((shift as any).declared_methods)?.cash ?? (shift as any).closing_float) : null;
  res.json({ showCashier, declared: showCashier ? methodMap(shift?.declared_methods) : null, expected, cash });
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
  const { data, error } = await supabase
    .from('expenses').select('amount').eq('shift_id', shiftId)
    // 0.6.27: only a CASH expense leaves the drawer; one paid by M-Pesa comes off M-Pesa's expected (expectedByMethod).
    .eq('payment_method', 'cash');
  // P1-4: a failed read THROWS. Returning 0 stored a wrong expected cash and variance for good on a close.
  if (error) throw new Error(`shift expenses: ${error.message}`);
  return (data ?? []).reduce((sum, e: { amount: number }) => sum + Number(e.amount), 0);
}

/** Cash put into (float_in) and taken out of (float_out) a drawer. Throws on a failed read (P1-4). */
async function shiftFloats(shiftId: string): Promise<{ floatIn: number; floatOut: number }> {
  const { data, error } = await supabase.from('float_transactions').select('type, amount').eq('shift_id', shiftId);
  if (error) throw new Error(`shift floats: ${error.message}`);
  const rows = (data ?? []) as Array<{ type: string; amount: number | string }>;
  return {
    floatIn:  rows.filter(f => f.type === 'float_in') .reduce((s, f) => s + Number(f.amount), 0),
    floatOut: rows.filter(f => f.type === 'float_out').reduce((s, f) => s + Number(f.amount), 0),
  };
}

/**
 * P1-3: the shift to close, or the answer already sent — 404 NOT_FOUND only when there is no such shift in this business,
 * 409 ALREADY_CLOSED (with its status and closed_at) when it is there but not open, 5xx when the read itself failed.
 */
async function openShiftOr409(req: Request, res: Response, id: string,
  onClosed?: (shift: Record<string, any>) => Promise<boolean>): Promise<Record<string, any> | null> {
  const { data: shift, error } = await supabase
    .from('shifts').select('*').eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error, { status: 503, message: 'Could not read the shift — try again' }); return null; }
  if (!shift) { res.status(404).json({ error: 'Shift not found', code: 'NOT_FOUND' }); return null; }
  if ((shift as { status?: string }).status !== 'open') {
    // A522 (for A521): `till_count_recorded: true` when the till's own count is kept on the shift (now, or by an earlier
    // send of the same count) — the till then knows its count was not dropped. Absent otherwise.
    let kept = false;
    if (onClosed) { try { kept = await onClosed(shift as Record<string, any>); } catch (e) { console.error('[shifts] A522 till count not kept:', (e as Error)?.message ?? e); } }
    res.status(409).json({
      error: 'This shift is already closed.', code: 'ALREADY_CLOSED',
      status: (shift as { status?: string }).status ?? null, closed_at: (shift as { closed_at?: string | null }).closed_at ?? null,
      ...(kept ? { till_count_recorded: true } : {}),
    });
    return null;
  }
  return shift as Record<string, any>;
}

/** A conditional close matched no row: somebody closed it first — answered as P1-3's 409 (or 404 if it vanished). */
async function alreadyClosed(req: Request, res: Response, id: string): Promise<void> {
  const { data, error } = await supabase.from('shifts').select('status, closed_at').eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error, { status: 503, message: 'Could not read the shift — try again' }); return; }
  if (!data) { res.status(404).json({ error: 'Shift not found', code: 'NOT_FOUND' }); return; }
  res.status(409).json({ error: 'This shift is already closed.', code: 'ALREADY_CLOSED',
    status: (data as { status?: string }).status ?? null, closed_at: (data as { closed_at?: string | null }).closed_at ?? null });
}

/**
 * A522 (owner, 2026-10-17: "nothing may wait on a till that is switched off"): the web closed (or force-closed) a drawer
 * while its till was off; the till, back, sends its own count of it — and was answered 409 ALREADY_CLOSED, its count
 * dropped. It is kept now: shifts.till_counted_cash / till_counted_at (migration 148), a line in the notes, and the owner
 * is told ("T2 counted KES X after the web closed the drawer"). Only the till's own replay (desktop, the same till), once
 * per drawer, and only when it differs from what the close recorded (the till's own earlier close is not news). The 409
 * still follows — the till marks its close synced on it. Before migration 148 the count goes into the notes only.
 */
async function recordTillCount(req: Request, shift: Record<string, any>): Promise<boolean> {
  if (req.surface !== 'desktop') return false;
  const count = Number(req.body?.closing_float);
  if (!Number.isFinite(count) || count < 0) return false;
  if (terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') !== terminalKeyFromRequest(req)) return false;
  if (shift.till_counted_cash !== null && shift.till_counted_cash !== undefined) {   // kept already (once per drawer)
    return Math.round(Number(shift.till_counted_cash) * 100) === Math.round(count * 100);
  }
  const recorded = shift.closing_float === null || shift.closing_float === undefined ? null : Number(shift.closing_float);
  if (recorded !== null && Math.round(recorded * 100) === Math.round(count * 100)) return false;   // the same count — its own close
  const at = cleanCloseTime(req.body?.closed_at, shift.opened_at ?? null);
  const till = shift.terminal_code || 'The POS';
  const expected = shift.expected_cash === null || shift.expected_cash === undefined ? null : Number(shift.expected_cash);
  const note = `${till} counted ${count} at ${at.slice(0, 16).replace('T', ' ')} UTC after the drawer was closed on the web` +
    `${recorded === null ? ' (closed uncounted)' : ` (the web count was ${recorded})`}${expected === null ? '' : ` — expected ${expected}`}.`;
  const notes = [shift.notes, note].filter(Boolean).join('\n');
  let { error } = await supabase.from('shifts').update({ till_counted_cash: count, till_counted_at: at, notes })
    .eq('id', shift.id).eq('business_id', req.businessId).is('till_counted_cash', null);
  if (error && /till_counted/.test(error.message ?? '')) {   // before migration 148
    ({ error } = await supabase.from('shifts').update({ notes }).eq('id', shift.id).eq('business_id', req.businessId));
  }
  if (error) { console.error('[shifts] A522 the till\'s count was not kept:', error.message); return false; }
  await notifyOwner(req.businessId!, shift.branch_id ?? null, 'till_count_after_close',
    `${till} counted ${kes(count)} after the web closed the drawer`,
    `${till} counted ${kes(count)} for shift ${String(shift.id).slice(0, 8)}, which was ${recorded === null ? 'force-closed uncounted' : `closed on the web with ${kes(recorded)}`}` +
    `${expected === null ? '' : `; it expected ${kes(expected)} (a difference of ${kes(count - expected)} by the POS's count)`}. Check the drawer and confirm it.`);
  return true;
}

/**
 * A522: the same for a confirmation — a manager confirmed the shift on the till while it was off, and the web confirmed it
 * first; the till's replay was answered 409 ALREADY_CONFIRMED and its counts dropped. They are kept in
 * shifts.till_confirmed_methods (migration 148) when they differ, and the owner is told.
 */
async function recordTillConfirmation(req: Request, shift: Record<string, any>, counts: MethodMap): Promise<boolean> {
  if (req.surface !== 'desktop' || typeof req.body?.confirmed_by !== 'string') return false;
  if (terminalKey(shift.device_id ?? '', shift.terminal_code ?? '', shift.branch_id ?? '') !== terminalKeyFromRequest(req)) return false;
  const sameAs = (a: MethodMap) => Object.keys({ ...a, ...counts }).every((m) => Math.round(Number(a[m] ?? 0) * 100) === Math.round(Number(counts[m] ?? 0) * 100));
  if (shift.till_confirmed_methods) return sameAs(methodMap(shift.till_confirmed_methods) ?? {});   // kept already
  if (sameAs(methodMap(shift.confirmed_methods) ?? {})) return false;   // the same counts — nothing to keep
  const { error } = await supabase.from('shifts').update({ till_confirmed_methods: counts })
    .eq('id', shift.id).eq('business_id', req.businessId).is('till_confirmed_methods', null);
  if (error) { console.error('[shifts] A522 the till\'s confirmation was not kept:', error.message); return false; }
  const till = shift.terminal_code || 'The POS';
  const line = Object.entries(counts).map(([m, v]) => `${m} ${kes(v)}`).join(', ');
  await notifyOwner(req.businessId!, shift.branch_id ?? null, 'till_confirm_after_close',
    `${till}: a manager confirmed different counts after the web did`,
    `For shift ${String(shift.id).slice(0, 8)}, a manager on ${till} counted ${line}; the web confirmation stands. Check which is right.`);
  return true;
}

/** How far ahead of the cloud's clock a till's close time may be (its clock may run a little fast). */
const CLOSE_CLOCK_SLACK_MS = 5 * 60_000;

/**
 * P2-11 / P0-1: when the drawer was counted. A till replays its close later and sends its own `closed_at`; it is taken when
 * it is a real time, not more than 5 minutes ahead of now and not before the shift opened — anything else (and every web
 * close) is now. Never refused: refusing a till's replay makes it retry forever.
 */
export function cleanCloseTime(raw: unknown, openedAt: string | null, now: Date = new Date()): string {
  const fallback = now.toISOString();
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return fallback;
  if (t > now.getTime() + CLOSE_CLOCK_SLACK_MS) return fallback;
  if (openedAt) { const o = Date.parse(openedAt); if (Number.isFinite(o) && t < o) return fallback; }
  return new Date(t).toISOString();
}
function tillCloseTime(req: Request, openedAt: string | null): string {
  return req.surface === 'desktop' ? cleanCloseTime(req.body?.closed_at, openedAt) : new Date().toISOString();
}

/** P2-11: who closed it — the person the till names (`closed_by`) when they are on this business's roster; else the caller. */
async function tillClosedBy(req: Request): Promise<string | null> {
  const named = req.surface === 'desktop' && typeof req.body?.closed_by === 'string' ? req.body.closed_by.trim() : '';
  if (named && /^[0-9a-f-]{36}$/i.test(named)) {
    const { data } = await supabase.from('users').select('id').eq('id', named).eq('business_id', req.businessId).maybeSingle();
    if (data) return named;
  }
  return req.userId ?? null;
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
async function openSiblingCash(shift: { id: string; status: string; business_id?: string; device_id?: string | null; terminal_code?: string | null; branch_id?: string | null }, businessId: string, closeAt: string | null): Promise<SiblingCash[]> {
  if (shift.status !== 'open') return [];
  const cols = 'id, status, device_id, terminal_code, branch_id, opening_float, opened_at, opened_by, cashier_id, business_day_id';
  let { data: open, error }: { data: any[] | null; error: any } = await supabase.from('shifts').select(`${cols}, opened_via`).eq('business_id', businessId).eq('status', 'open');
  // Before migration 133 there is no opened_via: siblingDrawers.isWebStandIn reads business_day_id instead.
  if (error && /opened_via/.test(error.message ?? '')) ({ data: open, error } = await supabase.from('shifts').select(cols).eq('business_id', businessId).eq('status', 'open'));
  // A failed read must not close a drawer without the cash it covers: the caller answers 5xx and the till retries.
  if (error) throw new Error(`sibling shifts: ${error.message}`);
  const sibs = siblingsOf(shift, (open ?? []) as any[], closeAt);
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

/** The cash a shift's completed orders took (refunds are negative cash rows, so this is net). A527: shown on its own on
 *  the manager's confirm screen, as well as inside expected cash. */
async function shiftCashSales(shiftId: string): Promise<number> {
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
  return cashSales;
}

/** A594: expected cash and the parts it is made of — the web's Shift Reports shows them (drawer-figure viewers only). */
export interface ExpectedCashParts {
  opening_float: number; cash_sales: number; cash_in: number; cash_out: number; expenses: number; expected: number;
}
export async function computeExpectedCashParts(shiftId: string, openingFloat: number): Promise<ExpectedCashParts> {
  const cashSales = await shiftCashSales(shiftId);
  const { floatIn, floatOut } = await shiftFloats(shiftId);   // P1-4: throws on a failed read
  const expenses = await shiftExpenses(shiftId);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    opening_float: r2(Number(openingFloat)), cash_sales: r2(cashSales), cash_in: r2(floatIn), cash_out: r2(floatOut),
    expenses: r2(expenses), expected: Number(openingFloat) + cashSales + floatIn - floatOut - expenses,
  };
}

export async function computeExpectedCash(shiftId: string, openingFloat: number): Promise<number> {   // A476: the owner emails show it too
  return (await computeExpectedCashParts(shiftId, openingFloat)).expected;
}

/**
 * A594: the cash in / cash out and cash expenses of a shift, each with when, why, who recorded it and who approved it —
 * the lines behind expected cash (the incident: two "Cash in" entries with no reason and no approver).
 */
export async function shiftCashMovements(shiftId: string, floats?: Array<Record<string, any>> | null): Promise<Array<{
  kind: 'cash_in' | 'cash_out' | 'expense'; amount: number; at: string | null; reason: string | null; by: string | null; approved_by: string | null;
}>> {
  const [fl, ex] = await Promise.all([
    floats ? Promise.resolve({ data: floats, error: null })
      : supabase.from('float_transactions').select('type, amount, reason, created_at, cashier_id, approved_by_name').eq('shift_id', shiftId),
    supabase.from('expenses').select('description, amount, created_at, recorded_by, paid_by, approved_by_name')
      .eq('shift_id', shiftId).eq('payment_method', 'cash'),
  ]);
  if (fl.error) throw new Error(`shift floats: ${fl.error.message}`);
  if (ex.error) throw new Error(`shift expenses: ${ex.error.message}`);
  const floatRows = (fl.data ?? []) as Array<Record<string, any>>;
  const expRows = (ex.data ?? []) as Array<Record<string, any>>;
  const ids = [...new Set([...floatRows.map((f) => f.cashier_id), ...expRows.map((e) => e.recorded_by ?? e.paid_by)].filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: us } = await supabase.from('users').select('id, name').in('id', ids.slice(0, 500));
    for (const u of (us ?? []) as Array<{ id: string; name: string }>) names.set(u.id, u.name);
  }
  const out = [
    ...floatRows.filter((f) => f.type === 'float_in' || f.type === 'float_out').map((f) => ({
      kind: (f.type === 'float_in' ? 'cash_in' : 'cash_out') as 'cash_in' | 'cash_out', amount: Number(f.amount) || 0,
      at: f.created_at ?? null, reason: f.reason ?? null, by: f.cashier_id ? (names.get(f.cashier_id) ?? null) : null,
      approved_by: f.approved_by_name ?? null })),
    ...expRows.map((e) => ({
      kind: 'expense' as const, amount: Number(e.amount) || 0, at: e.created_at ?? null, reason: e.description ?? null,
      by: (e.recorded_by ?? e.paid_by) ? (names.get(e.recorded_by ?? e.paid_by) ?? null) : null, approved_by: e.approved_by_name ?? null })),
  ];
  return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
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
router.post('/:id/force-close', requirePermission('shifts.force_close'), async (req, res) => {
  const { id } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  // A forced close with no stated reason is an unexplained hole in the cash
  // record, which is worse than the open shift it replaces.
  if (!reason) {
    res.status(400).json({ error: 'A reason is required to force-close a shift' });
    return;
  }

  // P1-3: 404 NOT_FOUND / 409 ALREADY_CLOSED / 5xx, as /:id/close.
  const shift = await openShiftOr409(req, res, id);
  if (!shift) return;
  if (notThisBranch(req, res, shift)) return;   // A494

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

  // P1-4: a failed float / expense read is a 5xx, never a 0 inside the stored expected cash.
  let floatIn = 0, floatOut = 0, expensesOut = 0;
  try {
    ({ floatIn, floatOut } = await shiftFloats(id));
    expensesOut = await shiftExpenses(id);
  } catch (e) { sendError(res, e as Error); return; }
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
    .eq('business_id', req.businessId)
    .eq('status', 'open')   // conditional: never overwrites a close that landed first
    .select()
    .maybeSingle();

  if (closeErr) { sendError(res, closeErr); return; }
  if (!closed) { await alreadyClosed(req, res, id); return; }
  res.json(closed);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shifts/:id/float
// Records a float_in or float_out transaction during an open shift.
// Body: { type: 'float_in'|'float_out', amount, reason, pin?, count_ack? }   (A594: reason required)
// 0.6.37 (A388): a pay-out (float_out) needs a manager — signed in, or `pin` (a manager's). A pay-in needs nobody.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * A594 (owner, 2026-10-26: "we need to turn off that option for cashiers by default unless allowed"): a cash in needs no
 * approver only for someone who holds shifts.cash_movements ("Record cash in" — lib/historyScope.ts mayMoveMoney, the
 * switch rule before migration 134); a cash out always needs one (A388). A453's refusal of everyone else is gone: a
 * manager approves on the spot (signed in, or `pin`). Every one gives a reason; a cash in of what the drawer should hold
 * (or its cash sales) answers 409 CASH_IN_LOOKS_LIKE_COUNT until the person confirms it (`count_ack: true`).
 */
router.post('/:id/float', async (req, res) => {
  const { id } = req.params;
  const { type, amount } = req.body;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';

  if (!type || !amount || !['float_in', 'float_out'].includes(type)) {
    res.status(400).json({ error: 'type (float_in|float_out) and amount are required' });
    return;
  }
  if (!(Number(amount) > 0)) {
    res.status(400).json({ error: 'amount must be greater than zero' });
    return;
  }

  // Verify shift is open and belongs to this business
  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('id, branch_id, status, opening_float')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .single();

  if (shiftErr || !shift) {
    res.status(404).json({ error: 'Open shift not found' });
    return;
  }
  if (notThisBranch(req, res, shift)) return;   // A494
  if (!reason) { res.status(400).json({ error: CASH_MOVEMENT_REASON_REQUIRED, code: 'REASON_REQUIRED' }); return; }   // A594

  // A594: a drawer count typed into Cash in — asked again before anything is written. The figures never go back (a
  // cashier's close stays blind); a failed read only skips the warning.
  if (type === 'float_in' && req.body?.count_ack !== true) {
    try {
      const parts = await computeExpectedCashParts(shift.id, Number((shift as { opening_float?: number }).opening_float) || 0);
      if (looksLikeDrawerCount(Number(amount), { openingFloat: parts.opening_float, cashSales: parts.cash_sales, expected: parts.expected })) {
        res.status(409).json({ error: DRAWER_COUNT_WARNING, code: DRAWER_COUNT_CODE });
        return;
      }
    } catch { /* no figures — no warning */ }
  }

  let approver: { id: string; name: string | null } | null = null;
  if (cashMovementNeedsApprover(type, mayMoveMoney(req as any, await businessPosFeatures(req.businessId)))) {
    const a = await payoutApprover(req, shift.branch_id ?? null);   // A494: an approver of the drawer's branch
    if (a.ok === false) { res.status(a.status).json({ error: a.error, code: a.code }); return; }
    approver = a.approver;
  }

  const { data, error } = await supabase
    .from('float_transactions')
    .insert({
      shift_id: id,
      branch_id: shift.branch_id,
      cashier_id: req.userId,
      type,
      amount: Number(amount),
      reason,
      approved_by: approver?.id ?? null,         // 0.6.37 (A388)
      approved_by_name: approver?.name ?? null,
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
  const paymentMethod = cleanExpenseMethod(req.body?.payment_method);   // 0.6.27: only cash leaves the drawer

  if (!description) { res.status(400).json({ error: 'Say what the money was for (description).' }); return; }
  if (description.length > 255) { res.status(400).json({ error: 'Description is too long (255 characters at most).' }); return; }
  if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ error: 'Enter an amount greater than zero.' }); return; }
  // A594: no refusal by key any more — every drawer expense is approved by a manager below (A388), key or not.

  const { data: shift, error: shiftErr } = await supabase
    .from('shifts')
    .select('id, branch_id, status')
    .eq('id', id)
    .eq('business_id', req.businessId)
    .eq('status', 'open')
    .maybeSingle();
  if (shiftErr) { sendError(res, shiftErr); return; }
  if (!shift) { res.status(404).json({ error: 'Open shift not found' }); return; }
  if (notThisBranch(req, res, shift)) return;   // A494

  // 0.6.37 (A388): every expense from the POS needs a manager — signed in, or `pin` (a manager's).
  const approval = await payoutApprover(req, (shift as { branch_id?: string | null }).branch_id ?? null);   // A494
  if (approval.ok === false) { res.status(approval.status).json({ error: approval.error, code: approval.code }); return; }

  if (categoryId) {
    const { data: cat } = await supabase.from('expense_categories').select('id')
      .eq('id', categoryId).eq('business_id', req.businessId).maybeSingle();
    if (!cat) { res.status(400).json({ error: 'That expense type no longer exists — pick another.' }); return; }
  }

  const who = await recorderId(req);
  // P2-14: the business date (its "day ends at" cut-off, the branch's own wins), not the UTC date — an expense at 01:00
  // Nairobi time was dated the day before, and one after a 04:00 cut-off belongs to the night it was spent in.
  const expenseDate = businessDateEAT(new Date(), await getDayCutoff(req.businessId, (shift as { branch_id: string }).branch_id));
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
      expense_date:        expenseDate,
      payment_method:      paymentMethod,
      approved_by:         approval.approver.id,       // 0.6.37 (A388)
      approved_by_name:    approval.approver.name,
    })
    .select('id, description, amount, expense_date, expense_category_id, created_at, payment_method, approved_by_name')
    .single();

  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/branch-report?from=&to=&tz_offset_min=
// A431 / A432 (owner, 2026-10-09: "the manager should view sales across all tills no matter the till they have logged
// into … add a shift report in the overview"). The branch's sales in the range, in the shape the till's Overview draws,
// and every shift that was open in it (opened before `to`, and still open or closed after `from`) with its own sales,
// expected and counted cash and where it stands. Every till and the web POS. A MANAGER's (a person who may confirm a
// shift — never a cashier: the cashier's close is blind, never the till's own session, A415). Open to the till (unlike
// /api/reports, web-only), reached through the branch server on a till behind one (A410).
// ─────────────────────────────────────────────────────────────────────────────
const REPORT_PAGE = 500;
const ORDER_COLS = 'id, created_at, device_id, shift_id, cashier_id, total, vat_amount, ctl_amount, refunded_amount, refunded_at, '
  + 'discount_amount, tip_amount, payments ( method, amount, status )';

/** Every completed order at the branch in a time range, or of some shifts — paged: a plain select stops silently at the
 *  row cap (lib/pgQuery.ts). */
async function allOrders(businessId: string, by: { branchId: string; from: string; to: string } | { shiftIds: string[] }): Promise<any[]> {
  const out: any[] = [];
  for (let at = 0; ; at += REPORT_PAGE) {
    let q = supabase.from('orders').select(ORDER_COLS).eq('business_id', businessId).eq('status', 'completed');
    q = 'shiftIds' in by
      ? q.in('shift_id', by.shiftIds)
      : q.eq('branch_id', by.branchId).gte('created_at', by.from).lte('created_at', by.to);
    const { data, error } = await q.order('id', { ascending: true }).range(at, at + REPORT_PAGE - 1);
    if (error) throw new Error(`branch-report orders: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < REPORT_PAGE) return out;
  }
}

function toBranchOrder(o: any): BranchOrder {
  const t = orderTax(o);
  return {
    id: o.id, created_at: o.created_at, device_id: o.device_id ?? null, shift_id: o.shift_id ?? null,
    cashier_id: o.cashier_id ?? null,   // A440
    gross: t.gross, refunded: t.refunded, net: t.net, vat: t.vat, ctl: t.ctl,
    discount: Number(o.discount_amount ?? 0) || 0, tip: Number(o.tip_amount ?? 0) || 0,
    payments: (o.payments ?? []).map((p: any) => ({ method: String(p.method ?? 'other'), amount: Number(p.amount) || 0, status: p.status ?? null })),
  };
}

router.get('/branch-report', async (req, res) => {
  // A490: reports.shifts or shifts.confirm (never the till's own sign-in — a manager signs in).
  if (req.isTill || !can(req, 'reports.shifts', 'shifts.confirm')) { res.status(403).json({ error: 'A manager signs in to see the branch.', code: 'MANAGER_ONLY' }); return; }
  if (oneBranchOnly(req, res)) return;   // A582: one branch's report at a time
  const branchId = branchScope(req);
  if (!branchId) { res.status(400).json({ error: 'Which branch? (branch_id)' }); return; }
  const from = String(req.query.from ?? ''), to = String(req.query.to ?? '');
  const f = Date.parse(from), t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) { res.status(400).json({ error: 'from and to must be times, from first' }); return; }
  if (t - f > 32 * 86_400_000) { res.status(400).json({ error: 'At most a month at a time' }); return; }
  const tz = Math.max(-840, Math.min(840, Math.round(Number(req.query.tz_offset_min ?? 180)) || 0));
  const fromIso = new Date(f).toISOString(), toIso = new Date(t).toISOString();

  const [orders, shiftsRes, devicesRes] = await Promise.all([
    allOrders(req.businessId, { branchId, from: fromIso, to: toIso }),
    supabase.from('shifts')
      .select('id, device_id, terminal_code, cashier_id, status, opened_at, closed_at, opening_float, closing_float, '
        + 'expected_cash, cash_variance, close_method, declared_methods, confirmed_at, confirmed_by')
      .eq('business_id', req.businessId).eq('branch_id', branchId)
      .lte('opened_at', toIso).or(`status.eq.open,closed_at.gte.${fromIso}`)
      .order('opened_at', { ascending: false }).limit(200),
    supabase.from('user_devices').select('device_id, terminal_code, device_label')
      .eq('business_id', req.businessId).eq('branch_id', branchId).not('device_id', 'is', null),
  ]);
  if (shiftsRes.error) { sendError(res, shiftsRes.error); return; }
  const shifts = (shiftsRes.data ?? []) as any[];

  // A shift's own sales, whenever rung — a drawer opened before `from` still shows all of it.
  const shiftIds = shifts.map(s => s.id);
  // Paged inside each chunk too: ten busy shifts can pass the row cap together (chunkIn alone would truncate silently).
  const shiftOrders: any[] = [];
  for (let i = 0; i < shiftIds.length; i += 50) {
    const chunk = shiftIds.slice(i, i + 50);
    shiftOrders.push(...await allOrders(req.businessId, { shiftIds: chunk }));
  }

  const names = new Map<string, TillName>();
  for (const d of (devicesRes.data ?? []) as TillName[]) if (d.device_id && !names.has(d.device_id)) names.set(d.device_id, d);
  // A440: and everyone who rang a sale up, for staff performance.
  const personIds = [...new Set([...shifts.flatMap(s => [s.cashier_id, s.confirmed_by]), ...orders.map((o: any) => o.cashier_id)].filter(Boolean))] as string[];
  const people = new Map<string, string>();
  if (personIds.length) {
    const { data: users } = await supabase.from('users').select('id, name').in('id', personIds.slice(0, 500));
    for (const u of users ?? []) people.set(u.id, u.name);
  }
  const expectedOpen = new Map<string, number>();
  await Promise.all(shifts.filter(s => s.status === 'open').slice(0, 50).map(async s => {
    try { expectedOpen.set(s.id, await computeExpectedCash(s.id, Number(s.opening_float) || 0)); }
    catch { /* left out — the till shows "—", never a wrong figure */ }
  }));

  // A433: Item Mix for every till — the lines of the range's orders, by product, paged inside each chunk.
  const itemTotals = new Map<string, { name: string; qty: number; revenue: number }>();
  const orderIds = orders.map((o: any) => o.id as string);
  for (let i = 0; i < orderIds.length; i += 100) {
    const chunk = orderIds.slice(i, i + 100);
    for (let at = 0; ; at += REPORT_PAGE) {
      const { data, error } = await supabase.from('order_items').select('id, product_name, quantity, subtotal')
        .in('order_id', chunk).order('id', { ascending: true }).range(at, at + REPORT_PAGE - 1);
      if (error) { sendError(res, error); return; }
      for (const it of (data ?? []) as Array<{ product_name: string | null; quantity: unknown; subtotal: unknown }>) {
        const name = it.product_name ?? 'Item';
        const v = itemTotals.get(name) ?? { name, qty: 0, revenue: 0 };
        v.qty += Number(it.quantity) || 0; v.revenue += Number(it.subtotal) || 0;
        itemTotals.set(name, v);
      }
      if ((data ?? []).length < REPORT_PAGE) break;
    }
  }
  const topProducts = [...itemTotals.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 50)
    .map((p) => ({ name: p.name, qty: Math.round(p.qty * 1000) / 1000, revenue: Math.round(p.revenue * 100) / 100 }));
  const declaredCodes = new Map(shifts.map((s) => [s.id as string, Object.keys(methodMap(s.declared_methods) ?? {})]));

  const num = (v: unknown) => (v == null ? null : Number(v));
  const report = buildBranchReport({
      orders: orders.map(toBranchOrder),
      shifts: shifts.map((s): BranchShift => ({
        id: s.id, device_id: s.device_id ?? null, terminal_code: s.terminal_code ?? null, cashier_id: s.cashier_id ?? null,
        status: s.status, opened_at: s.opened_at, closed_at: s.closed_at ?? null,
        opening_float: Number(s.opening_float) || 0, closing_float: num(s.closing_float),
        expected_cash: num(s.expected_cash), cash_variance: num(s.cash_variance), close_method: s.close_method ?? null,
        declared_methods: s.declared_methods ?? null, confirmed_at: s.confirmed_at ?? null, confirmed_by: s.confirmed_by ?? null,
      })),
      shiftOrders: (shiftOrders as any[]).map(toBranchOrder),
      names, people, expectedOpen, tzOffsetMin: tz,
  });
  res.json({
    scope: 'branch',
    from: fromIso, to: toIso,
    ...report,
    // A433: what a manager recounts to confirm each shift (the methods the cashier declared; cash always).
    shifts: report.shifts.map((x) => ({ ...x, declare_codes: declaredCodes.get(x.id) ?? [] })),
    topProducts,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts/:id/zreport — A433 (owner, 2026-10-10: "under sales report it should cover all tills when logged in as
// the manager"). Any shift at the branch as a Z-report in the till's own shape (lib/shiftZReport.ts), for a manager on a
// till that does not hold it. A manager only, the caller's branch.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/zreport', async (req, res) => {
  // A490: reports.shifts or shifts.confirm (never the till's own sign-in — a manager signs in).
  if (req.isTill || !can(req, 'reports.shifts', 'shifts.confirm')) { res.status(403).json({ error: 'A manager signs in to see another POS\'s shift.', code: 'MANAGER_ONLY' }); return; }
  const { data: shift, error } = await supabase.from('shifts').select('*')
    .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return; }
  // A582: in a partner's set, the shift's branch when it is one of theirs (else none); everyone else as before
  const f = branchFilter(req);
  const branchId = f.kind === 'set' ? (shift && f.ids.includes(shift.branch_id) ? shift.branch_id : NO_BRANCH) : branchScope(req);
  if (!shift || (branchId && shift.branch_id !== branchId)) { res.status(404).json({ error: 'Shift not found' }); return; }

  const [orders, voids, floats, exps, biz] = await Promise.all([
    allOrders(req.businessId!, { shiftIds: [shift.id] }),
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('shift_id', shift.id).eq('status', 'voided'),
    supabase.from('float_transactions').select('type, amount').eq('shift_id', shift.id),
    supabase.from('expenses').select('description, amount, created_at, payment_method, paid_by').eq('shift_id', shift.id).order('created_at'),
    supabase.from('businesses').select('ctl_rate').eq('id', req.businessId).maybeSingle(),
  ]);
  // A442: and everyone who rang a sale up on it.
  const ids = [...new Set([shift.cashier_id, shift.confirmed_by, ...((exps.data ?? []) as any[]).map((e) => e.paid_by),
    ...orders.map((o: any) => o.cashier_id)].filter(Boolean))] as string[];
  const nameOf = new Map<string, string>();
  if (ids.length) {
    const { data: us } = await supabase.from('users').select('id, name').in('id', ids);
    for (const u of us ?? []) nameOf.set(u.id, u.name);
  }
  const declared = methodMap(shift.declared_methods);
  let confirmation = null as Parameters<typeof buildShiftZReport>[0]['confirmation'];
  if (declared || shift.confirmed_at) {
    const reasons = (shift.confirm_reasons ?? {}) as Record<string, string>;
    const lines = (shift.confirmed_at
      ? confirmationLines(declared, methodMap(shift.expected_methods), methodMap(shift.confirmed_methods))
      : confirmationLines(declared, null, null)).map((l) => (reasons[l.method] ? { ...l, reason: reasons[l.method] } : l));
    confirmation = {
      declared, lines, methods: [...new Set(['cash', ...Object.keys(declared ?? {})])],
      confirmedByName: shift.confirmed_by ? (nameOf.get(shift.confirmed_by) ?? null) : null,
    };
  }
  let expectedNow: number | null = null;
  if (shift.status === 'open') { try { expectedNow = await computeExpectedCash(shift.id, Number(shift.opening_float) || 0); } catch { /* computed from the rows */ } }
  const n = (v: unknown) => (v == null ? null : Number(v));
  res.json(buildShiftZReport({
    shift: {
      id: shift.id, status: shift.status, opened_at: shift.opened_at, closed_at: shift.closed_at ?? null,
      cashier_id: shift.cashier_id ?? null, opening_float: Number(shift.opening_float) || 0,
      closing_float: n(shift.closing_float), expected_cash: n(shift.expected_cash), cash_variance: n(shift.cash_variance),
      notes: shift.notes ?? null, confirmed_at: shift.confirmed_at ?? null, confirm_self: shift.confirm_self ?? null,
    },
    cashierName: (shift.cashier_id && nameOf.get(shift.cashier_id)) || 'Unknown',
    orders: orders.map(toBranchOrder),
    people: nameOf,   // A442
    voidCount: voids.count ?? 0,
    floatTxns: ((floats.data ?? []) as any[]).map((f) => ({ type: f.type, amount: Number(f.amount) || 0 })),
    expenses: ((exps.data ?? []) as any[]).map((e) => ({
      description: e.description ?? null, amount: Number(e.amount) || 0, created_at: e.created_at,
      payment_method: e.payment_method ?? 'cash', paid_by_name: e.paid_by ? (nameOf.get(e.paid_by) ?? null) : null,
    })),
    expectedNow,
    ctlLevied: Number((biz.data as any)?.ctl_rate ?? 0) > 0,
    confirmation,
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shifts
// Lists shifts for the business. Supports filters: branch_id, status, from, to.
// Enriches with cashier name (fetched separately to avoid Supabase FK join issues).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { status, from, to, limit = '50' } = req.query as Record<string, string>;
  const bf = branchFilter(req);   // A582: one branch, all, or a partner's set

  let query = supabase
    .from('shifts')
    .select('*')
    .eq('business_id', req.businessId)
    .order('opened_at', { ascending: false })
    .limit(Math.min(Number(limit), 200));

  query = byBranch(query, bf);
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
  const partsById = new Map<string, ExpectedCashParts>();   // A594: what it is made of
  await Promise.all(openOnes.map(async s => {
    try {
      const parts = await computeExpectedCashParts(s.id, Number(s.opening_float));
      expectedById.set(s.id, parts.expected);
      partsById.set(s.id, parts);
    } catch {
      /* leave absent — the UI shows "unavailable" rather than a wrong number */
    }
  }));

  // A494: a drawer's figures only to someone who may see them (seesDrawerFigures) — and their own drawer to its cashier,
  // as before; everyone else gets the drawers without expected cash, the difference or the declared / counted amounts.
  // A522: when each drawer's till was last heard from — the web warns before it closes a drawer whose till has been
  // silent (its sales since are not in the close; it applies the close when it next connects). Best-effort.
  const tillSeen = new Map<string, { last_sync_at: string | null; retired_at: string | null }>();
  const tillIds = [...new Set(shifts.map(s => s.device_id).filter((d): d is string => typeof d === 'string' && !!d))];
  if (tillIds.length) {
    const { data: devs } = await supabase.from('user_devices').select('device_id, last_sync_at, retired_at')
      .eq('business_id', req.businessId).in('device_id', tillIds.slice(0, 200));
    for (const d of (devs ?? []) as Array<{ device_id: string; last_sync_at: string | null; retired_at: string | null }>) {
      tillSeen.set(d.device_id, { last_sync_at: d.last_sync_at ?? null, retired_at: d.retired_at ?? null });
    }
  }

  const figures = seesDrawerFigures(req);
  const enriched = shifts.map(s => (figures || ownDrawer(req, s) ? (x: any) => x : withoutFigures)({
    ...s,
    till_last_sync_at: s.device_id ? (tillSeen.get(s.device_id)?.last_sync_at ?? null) : null,
    till_retired: s.device_id ? !!tillSeen.get(s.device_id)?.retired_at : false,
    cashier_name: nameMap[s.cashier_id] ?? 'Unknown',
    confirmer_name: s.confirmed_by ? (nameMap[s.confirmed_by] ?? null) : null,
    // A365: closed under the new rule (declared every method) and not yet confirmed by a manager.
    awaiting_confirmation: s.status !== 'open' && s.declared_methods != null && s.confirmed_at == null,
    expected_cash_live: expectedById.has(s.id) ? expectedById.get(s.id) : null,
    // A594: the parts of expected cash — only to someone who may see drawer figures (never the cashier's own drawer view).
    ...(figures && partsById.has(s.id) ? { expected_cash_parts: partsById.get(s.id) } : {}),
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
      .select('id, total, refunded_amount, created_at, cashier_id, payments ( method, amount, status )')   // A442: + who
      .eq('shift_id', id)
      .eq('status', 'completed'),
  ]);

  if (sErr || !shift) { res.status(404).json({ error: 'Shift not found' }); return; }
  // Audit 2026-10-14: a non-owner reads only shifts of the branch they are signed in at (the business was already checked
  // above). A person with no branch (works at every branch, A426) keeps the business-wide view GET /api/shifts gives them.
  // A550: a partner of every branch reads any of their branches' shifts (as the owner any).
  if (!req.isOwner && (req.allBranches || inBranchSet(req) ? !assertBranchAccess(req, shift.branch_id) : (req.branchId && shift.branch_id !== req.branchId))) { res.status(404).json({ error: 'Shift not found' }); return; }

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

  // A442: who sold what on this drawer — each person's orders, sales kept after refunds and money by method.
  const sellerIds = [...new Set((orders ?? []).map((o: any) => o.cashier_id).filter(Boolean))] as string[];
  const sellerNames = new Map<string, string>();
  if (sellerIds.length) {
    const { data: us } = await supabase.from('users').select('id, name').in('id', sellerIds.slice(0, 500));
    for (const u of us ?? []) sellerNames.set(u.id, u.name);
  }
  const byCashier = shiftByCashier((orders ?? []).map((o: any) => ({
    cashier_id: o.cashier_id ?? null,
    net: Number(o.total) - Math.min(Math.max(Number(o.refunded_amount ?? 0), 0), Number(o.total)),
    payments: (o.payments ?? []).map((p: any) => ({ method: String(p.method ?? 'other'), amount: Number(p.amount) || 0, status: p.status ?? null })),
  })), sellerNames);

  // 0.6.27 ('blind_shift_close'): a cashier gets which methods to declare, never the figures.
  const declareMethods = [...new Set((byMethod as Array<{ method: string; amount: number }>)
    .filter((m) => String(m.method).toLowerCase() !== 'cash' && Math.round(Number(m.amount) * 100) !== 0)
    .map((m) => String(m.method).toLowerCase()))].sort((a, b) => a.localeCompare(b));
  // A494: someone who may not see drawer figures sees ANOTHER person's drawer blind too (it was the full report for anyone
  // at the branch); their own drawer keeps the owner's 'blind_shift_close' rule, as before.
  const blind = !seesDrawerFigures(req) && !callerMayConfirm(req)
    && (!ownDrawer(req, shift) || (await businessPosFeatures(req.businessId)).blind_shift_close);
  if (blind) {
    // A416: the owner's switch (off by default) — the cashier sees their shift's sales (kept after refunds) and orders.
    // Never expected cash, the per-method figures or the difference: the count stays blind.
    const seesSales = await cashierSeesShiftSales(req.businessId!, shift.branch_id);
    const kept = (orders ?? []).reduce((s: number, o: any) => s + Number(o.total) - Math.min(Math.max(Number(o.refunded_amount ?? 0), 0), Number(o.total)), 0);
    res.json({
      id: shift.id, status: shift.status, opened_at: shift.opened_at, cashier_id: shift.cashier_id, opened_by: shift.opened_by,
      cashier_name: cashier?.name ?? 'Unknown', blind: true, declare_methods: declareMethods,
      ...(seesSales ? { cashier_sales: { total: Math.round(kept * 100) / 100, orders: (orders ?? []).length,
        // A442: each person's part — sales only, never a method's figure (the count stays blind).
        by_cashier: byCashier.map((c) => ({ name: c.name, orders: c.orders, sales: c.sales })) } } : {}),
    });
    return;
  }
  // A594: expected cash, part by part, with every cash in / cash out and cash expense (when, why, who, approved by) —
  // only to someone who may see drawer figures (seesDrawerFigures, A494). A failed read leaves it out (never a wrong sum).
  let expectedBreakdown: (ExpectedCashParts & { movements: Awaited<ReturnType<typeof shiftCashMovements>> }) | null = null;
  if (seesDrawerFigures(req)) {
    try {
      const [parts, movements] = await Promise.all([
        computeExpectedCashParts(shift.id, Number(shift.opening_float) || 0),
        shiftCashMovements(shift.id, (floatTxns ?? null) as Array<Record<string, any>> | null),
      ]);
      expectedBreakdown = { ...parts, movements };
    } catch { /* left out */ }
  }
  res.json({
    ...shift,
    cashier_name: cashier?.name ?? 'Unknown',
    ...(expectedBreakdown ? { expected_breakdown: expectedBreakdown } : {}),   // A594
    float_transactions: floatTxns ?? [],
    order_count: (orders ?? []).length,
    total_revenue: totalRevenue,
    by_method: byMethod,
    by_cashier: byCashier,   // A442
    cash_sales: cashSales,
    float_in: floatIn,
    float_out: floatOut,
    expected_cash_computed: expectedCash,
    declare_methods: declareMethods,
  });
});

export default router;
