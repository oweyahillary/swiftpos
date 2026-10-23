/**
 * reports-monthly.ts — A455: a branch's month as the clients' own workbook (lib/monthlyPack.ts), and the money movements
 * the managers record for its cash / M-Pesa books (migration 130).
 *
 *   GET    /api/reports/monthly?month=YYYY-MM&branch_id=      the pack as JSON (the dashboard's Monthly pack tab)
 *   GET    /api/reports/monthly/export?month=&branch_id=      the same as an Excel workbook
 *   GET    /api/reports/monthly/movements?month=&branch_id=   the movements recorded for that month
 *   POST   /api/reports/monthly/movements                     record one (a manager: expenses.manage)
 *   DELETE /api/reports/monthly/movements/:id                 remove one recorded by mistake (expenses.manage)
 *
 * Owner, 2026-10-12: "I want to be able to generate such reports from the system"; "email and downloadable"; "manager can
 * record". A branch is required (the clients keep one workbook per branch); a branch manager sees their
 * own branch only.
 *
 * A466 (owner, 2026-10-13: "desktop app does not have some reports I added yesterday, can you add them"): the till's
 * manager screens read and record here too — a PERSON signed in on the till with their PIN (tillPersonOrWeb), with their
 * own permissions and branch as below. The till's own token (no person) stays out, as from every other web report.
 */
import ExcelJS from 'exceljs';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { branchScope, assertBranchAccess, requirePermission, requireAnyPermission, branchFilter, inBranchSet, PICK_ONE_BRANCH_BODY } from '../middleware/rbac';
import { sendError } from '../lib/sendError';
import { supabase } from '../lib/supabase';
import { recorderId } from '../lib/expenseRecorder';
import { loadPack, MISSING_TABLE } from '../lib/monthlyPackData';
import { writePackWorkbook, monthDays } from '../lib/monthlyPack';
import { cleanMovement } from '../lib/moneyMovements';

const router = safeRouter();
router.use(requireAuth);
router.use(tillPersonOrWeb);

/** A466: the web, the owner — and a person's PIN sign-in on a till (Manager › Sales › Monthly pack). Never the till's own
 *  token: it names no person (and carries every permission), so a stolen one must not read the books. */
function tillPersonOrWeb(req: any, res: any, next: any): void {
  if (req.surface === 'desktop' && req.pinSignIn === true && req.isTill !== true) { next(); return; }
  requireWebSurface(req, res, next);
}

/** The branch the pack is for: the owner's pick (header / query), a manager's own. */
function packBranch(req: any, res: any): string | null {
  // A582: "All my branches" — the pack is one branch: ?branch_id= one of theirs, else "Pick one of your branches".
  if (inBranchSet(req)) {
    const f = branchFilter(req);
    if (f.kind === 'one') return f.id;
    res.status(400).json({ ...PICK_ONE_BRANCH_BODY, error: 'Pick one of your branches — the monthly pack is one branch at a time.' }); return null;
  }
  const asked = typeof req.query.branch_id === 'string' && req.query.branch_id ? req.query.branch_id : null;
  const branch = asked ?? branchScope(req);
  if (!branch) { res.status(400).json({ error: 'Pick a branch — the monthly pack is one branch at a time.' }); return null; }
  if (!assertBranchAccess(req, branch)) { res.status(403).json({ error: 'That branch is not yours.' }); return null; }
  return branch;
}
function packMonth(req: any, res: any): string | null {
  const month = String(req.query.month ?? '');
  if (!monthDays(month).length) { res.status(400).json({ error: 'month must be YYYY-MM' }); return null; }
  return month;
}

// A490: reports.monthly_pack (what reports.financial gave here) or expenses.manage — A481 kept.
// A481 (owner, 2026-10-14: "the monthly pack ones I can't see them" — signed in as a Manager): the books' keeper reads them
// too. Managers keep the books (Record for the books = expenses.manage, A455) but are denied reports.financial by default
// (migration 82: Tax, Food Cost), so the pack was hidden from the very people who keep it.
router.get('/', requireAnyPermission('reports.monthly_pack', 'expenses.manage'), async (req: any, res) => {
  const branch = packBranch(req, res); if (!branch) return;
  const month = packMonth(req, res); if (!month) return;
  try { res.json(await loadPack(req.businessId, branch, month)); }
  catch (err: any) { if (err?.status) { res.status(err.status).json({ error: err.message }); return; } sendError(res, err, { message: 'Could not build the monthly pack' }); }
});

router.get('/export', requireAnyPermission('reports.monthly_pack', 'expenses.manage'), async (req: any, res) => {
  const branch = packBranch(req, res); if (!branch) return;
  const month = packMonth(req, res); if (!month) return;
  try {
    const pack = await loadPack(req.businessId, branch, month);
    const { data: biz } = await supabase.from('businesses').select('currency').eq('id', req.businessId).maybeSingle();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ZapTill';
    writePackWorkbook(wb, pack, (biz as any)?.currency ?? 'KES');
    const name = `zaptill-monthly-${pack.title.split(' — ')[1]?.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() || 'branch'}-${month}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err: any) { if (err?.status) { res.status(err.status).json({ error: err.message }); return; } sendError(res, err, { message: 'Could not build the monthly pack' }); }
});

router.get('/movements', requireAnyPermission('reports.monthly_pack', 'expenses.view', 'expenses.manage'), async (req: any, res) => {
  const branch = packBranch(req, res); if (!branch) return;
  const month = packMonth(req, res); if (!month) return;
  const days = monthDays(month);
  const { data, error } = await supabase.from('money_movements')
    .select('id, movement_date, method, kind, amount, note, recorded_by_name, created_at')
    .eq('business_id', req.businessId).eq('branch_id', branch)
    .gte('movement_date', days[0]).lte('movement_date', days[days.length - 1])
    .order('movement_date', { ascending: true });
  // A467: no money_movements table yet (migration 130) — nothing recorded, not a failure.
  if (error && MISSING_TABLE.test(String(error.message ?? ''))) { res.json([]); return; }
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

router.post('/movements', requirePermission('expenses.manage'), async (req: any, res) => {
  const c = cleanMovement(req.body);
  if (c.ok === false) { res.status(400).json({ error: c.error }); return; }
  if (!assertBranchAccess(req, c.value.branch_id)) { res.status(403).json({ error: 'That branch is not yours.' }); return; }
  const { data: br } = await supabase.from('branches').select('id').eq('id', c.value.branch_id).eq('business_id', req.businessId).maybeSingle();
  if (!br) { res.status(404).json({ error: 'Branch not found' }); return; }
  const who = await recorderId(req);
  const { data: u } = who ? await supabase.from('users').select('name').eq('id', who).maybeSingle() : { data: null };
  const { data, error } = await supabase.from('money_movements').insert({
    business_id: req.businessId, ...c.value, recorded_by: who, recorded_by_name: (u as any)?.name ?? null,
  }).select('id, movement_date, method, kind, amount, note, recorded_by_name, created_at').single();
  if (error) { sendError(res, error); return; }
  res.status(201).json(data);
});

router.delete('/movements/:id', requirePermission('expenses.manage'), async (req: any, res) => {
  const { data: row } = await supabase.from('money_movements').select('id, branch_id')
    .eq('id', req.params.id).eq('business_id', req.businessId).maybeSingle();
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  if (!assertBranchAccess(req, (row as any).branch_id)) { res.status(403).json({ error: 'That branch is not yours.' }); return; }
  const { error } = await supabase.from('money_movements').delete().eq('id', req.params.id).eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.json({ ok: true });
});

export default router;
