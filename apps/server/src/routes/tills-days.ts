// tills-days.ts — A523: the owner's (and a branch manager's) "Tills & days" page — every till, its open day and drawers,
// and the actions that close them from the cloud (lib/tillsDays.ts).
// ─────────────────────────────────────────────────────────────────────────────
// Owner, 2026-10-17: "there is no location on the cloud where I can close day as the owner or tech support remote force
// close." The owner sees every branch; anyone else holding shifts.close_day or shifts.force_close sees their own branch
// only (branchScope / assertBranchAccess). Figures (expected so far) only to reports.shifts / shifts.confirm holders.
//
//   GET  /overview                    — everything the page needs (shifts.close_day | shifts.force_close)
//   POST /close-day                   — close a till's day on the cloud AT ONCE, the till adopts it (shifts.close_day)
//   POST /close-drawer                — force-close a drawer, or close it with a count (shifts.force_close)
//   POST /instructions/:id/cancel     — withdraw a stuck close (shifts.close_day)
//   POST /abandon                     — close a retired / 24-h-silent till's day as abandoned (shifts.close_day)
// Every action needs a reason; a silent till needs `silent_ok`; each is audited and the owner told.
import { requirePermission, requireAnyPermission, branchScope, can, allBranchAccess } from '../middleware/rbac';   // A550: allBranchAccess
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { tillsOverview, cloudCloseDay, closeDrawer, cancelClose, abandonDay, TillsDaysError, type Actor } from '../lib/tillsDays';

const router = safeRouter();
router.use(requireAuth);

/** A till's own session never acts here — a person does. */
router.use((req: any, res, next) => {
  if (req.isTill) { res.status(403).json({ error: 'A till cannot use Tills & days — a person signs in.', code: 'PERSON_ONLY' }); return; }
  next();
});

async function actorOf(req: any): Promise<Actor> {
  const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
  return {
    businessId: req.businessId,
    userId: req.userId ?? null,
    name: (me as any)?.name ?? (req.isOwner ? 'The owner' : null),
    // The owner reaches every branch; anyone else their own (a branchless non-owner none — NO_BRANCH). A550: a partner of
    // every branch as the owner.
    branchId: allBranchAccess(req) ? null : String(branchScope(req) ?? ''),
  };
}

function answer(res: any, e: unknown): void {
  if (e instanceof TillsDaysError) { res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra }); return; }
  sendError(res, e as Error);
}

router.get('/overview', requireAnyPermission('shifts.close_day', 'shifts.force_close'), async (req: any, res) => {
  try {
    const actor = await actorOf(req);
    // The owner: the branch picked in the dashboard (X-Branch-Id / ?branch_id), or every branch.
    const branchId = allBranchAccess(req) ? (branchScope(req) || null) : actor.branchId;   // A550
    const ov = await tillsOverview(req.businessId, { branchId, seesFigures: can(req, 'reports.shifts', 'shifts.confirm') });
    res.json({ ...ov, may: { close_day: can(req, 'shifts.close_day'), force_close: can(req, 'shifts.force_close') },
      sees_figures: can(req, 'reports.shifts', 'shifts.confirm') });
  } catch (e) { answer(res, e); }
});

router.post('/close-day', requirePermission('shifts.close_day'), async (req: any, res) => {
  try {
    const b = req.body ?? {};
    res.json(await cloudCloseDay(await actorOf(req), { deviceId: b.device_id, businessDate: b.business_date, countedCash: b.counted_cash,
      reason: b.reason, forceDrawers: b.force_drawers === true, silentOk: b.silent_ok === true }));
  } catch (e) { answer(res, e); }
});

router.post('/close-drawer', requirePermission('shifts.force_close'), async (req: any, res) => {
  try {
    const b = req.body ?? {};
    res.json(await closeDrawer(await actorOf(req), { shiftId: b.shift_id, reason: b.reason, countedCash: b.counted_cash, silentOk: b.silent_ok === true }));
  } catch (e) { answer(res, e); }
});

router.post('/instructions/:id/cancel', requirePermission('shifts.close_day'), async (req: any, res) => {
  try { res.json(await cancelClose(await actorOf(req), { instructionId: req.params.id, reason: req.body?.reason })); }
  catch (e) { answer(res, e); }
});

router.post('/abandon', requirePermission('shifts.close_day'), async (req: any, res) => {
  try {
    const b = req.body ?? {};
    res.json(await abandonDay(await actorOf(req), { deviceId: b.device_id, businessDate: b.business_date, reason: b.reason, confirm: b.confirm === true }));
  } catch (e) { answer(res, e); }
});

export default router;
