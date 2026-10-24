/**
 * tillsDaysAdmin.ts — A523: "Tills & days" in the admin portal — support closes a client's till's day or drawer.
 *
 * Owner, 2026-10-17: "there is no location on the cloud where I can close day as the owner or tech support remote force
 * close" — and "super admins and agents" may rescue. The same actions as the owner's page (lib/tillsDays.ts), for the
 * client named in the path, by any active admin (requireAdmin — super_admin and agent):
 *
 *   GET  /api/admin/tills-days/:businessId/overview
 *   POST /api/admin/tills-days/:businessId/close-day
 *   POST /api/admin/tills-days/:businessId/close-drawer
 *   POST /api/admin/tills-days/:businessId/instructions/:id/cancel
 *   POST /api/admin/tills-days/:businessId/abandon
 *
 * Each action: a REQUIRED reason; the admin audit log (admin_audit_log) AND the business's audit_log; the owner told in
 * the app and by e-mail ("ZapTill support closed T2's day for 2026-10-15 — reason: …"); every super admin e-mailed to
 * verify when an agent did it (lib/adminVerifyNotice.ts, A507). Actions are rate-limited per admin.
 */
import rateLimit from 'express-rate-limit';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { notifySuperAdminsToVerify } from '../lib/adminVerifyNotice';
import {
  tillsOverview, cloudCloseDay, closeDrawer, cancelClose, abandonDay, emailOwnerOfSupportAction, TillsDaysError, type Actor,
} from '../lib/tillsDays';

const router = safeRouter();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A523: 30 actions per admin per 10 minutes — a rescue is a handful; a loop or a stolen session is stopped. */
export const ACTIONS_PER_WINDOW = 30;
const actionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: ACTIONS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => `admin:${String(req.adminId ?? 'none')}`,
  message: { error: 'Too many POS actions from this admin — wait a few minutes.', code: 'RATE_LIMITED' },
});

async function clientOf(req: any, res: any): Promise<{ id: string; name: string | null } | null> {
  const id = String(req.params.businessId ?? '');
  if (!UUID.test(id)) { res.status(400).json({ error: 'businessId must be an id' }); return null; }
  const { data, error } = await supabase.from('businesses').select('id, name').eq('id', id).maybeSingle();
  if (error) { sendError(res, error); return null; }
  if (!data) { res.status(404).json({ error: 'No such client' }); return null; }
  return data as { id: string; name: string | null };
}

const actorOf = (req: any, businessId: string): Actor => ({
  businessId, userId: null, name: `ZapTill support (${req.adminEmail})`, branchId: null,
  support: { adminId: req.adminId, email: req.adminEmail, role: req.adminRole },
});

async function adminAudit(req: any, client: { id: string; name: string | null }, action: string, after: object, reason: string): Promise<void> {
  const { error } = await supabase.from('admin_audit_log').insert({
    admin_id: req.adminId, admin_email: req.adminEmail, action, resource: 'tills_days',
    business_id: client.id, business_name: client.name, before_data: null, after_data: after, reason, ip_address: req.ip ?? null,
  });
  if (error) console.error('[admin tills-days] admin audit not written:', error.message);
}

function answer(res: any, e: unknown): void {
  if (e instanceof TillsDaysError) { res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra }); return; }
  sendError(res, e as Error);
}

/** After an action: the admin log, the owner's e-mail, the super admins when an agent did it. */
async function afterAction(req: any, client: { id: string; name: string | null }, action: string, line: string, detail: string,
  after: Record<string, unknown>, reason: string): Promise<boolean> {
  await adminAudit(req, client, action, after, reason);
  const emailed = await emailOwnerOfSupportAction(client.id, line, detail);
  notifySuperAdminsToVerify({ who: req.adminEmail, role: req.adminRole, what: line, client: client.name,
    changes: [{ field: 'Action', after: action }, { field: 'Reason', after: reason }] });
  return emailed;
}

router.get('/:businessId/overview', requireAdmin, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  try { res.json({ ...(await tillsOverview(client.id, { branchId: null, seesFigures: true })), may: { close_day: true, force_close: true }, sees_figures: true, client }); }
  catch (e) { answer(res, e); }
});

router.post('/:businessId/close-day', requireAdmin, actionLimiter, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  const b = req.body ?? {};
  try {
    const r = await cloudCloseDay(actorOf(req, client.id), { deviceId: b.device_id, businessDate: b.business_date, countedCash: b.counted_cash,
      reason: b.reason, forceDrawers: b.force_drawers === true, silentOk: b.silent_ok === true });
    const reason = String(b.reason).trim();
    const emailed = await afterAction(req, client, 'tills_days.close_day',
      `ZapTill support closed ${r.till}'s day for ${r.day.business_date} — reason: ${reason}`,
      `Counted ${r.day.counted_cash} (${r.counted_from === 'confirmed_shifts' ? 'the confirmed shift counts' : 'a count entered by support'}), expected ${r.day.expected_cash}, difference ${r.day.cash_variance}.` +
      (r.drawers_force_closed.length ? ` ${r.drawers_force_closed.length} open drawer(s) were force-closed uncounted first.` : '') +
      ` The POS adopts this close when it next connects. Done by ${req.adminEmail}.`,
      { device_id: b.device_id, till: r.till, business_date: r.day.business_date, ...r.day, drawers_force_closed: r.drawers_force_closed }, reason);
    res.json({ ...r, owner_emailed: emailed });
  } catch (e) { answer(res, e); }
});

router.post('/:businessId/close-drawer', requireAdmin, actionLimiter, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  const b = req.body ?? {};
  try {
    const r: any = await closeDrawer(actorOf(req, client.id), { shiftId: b.shift_id, reason: b.reason, countedCash: b.counted_cash, silentOk: b.silent_ok === true });
    const reason = String(b.reason).trim();
    const what = r.counted ? 'closed' : 'force-closed';
    const emailed = await afterAction(req, client, r.counted ? 'tills_days.count_close_drawer' : 'tills_days.force_close_drawer',
      `ZapTill support ${what} ${r.cashier}'s drawer on ${r.till} — reason: ${reason}`,
      `${r.counted ? `Closed with a count of ${r.shift?.closing_float}` : 'Recorded uncounted (no count, no difference)'}; expected ${r.shift?.expected_cash}. ` +
      `The POS closes it too when it next connects. Done by ${req.adminEmail}.`,
      { shift_id: b.shift_id, till: r.till, cashier: r.cashier, counted: r.counted }, reason);
    res.json({ ...r, owner_emailed: emailed });
  } catch (e) { answer(res, e); }
});

router.post('/:businessId/instructions/:id/cancel', requireAdmin, actionLimiter, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  try {
    const r: any = await cancelClose(actorOf(req, client.id), { instructionId: req.params.id, reason: req.body?.reason });
    const reason = String(req.body?.reason).trim();
    const emailed = await afterAction(req, client, 'tills_days.cancel_close',
      `ZapTill support withdrew a waiting day close on ${r.till} — reason: ${reason}`,
      `${r.delivered ? 'The POS had already collected it and may still carry it out. ' : ''}Done by ${req.adminEmail}.`,
      { instruction_id: req.params.id, till: r.till, delivered: r.delivered }, reason);
    res.json({ ...r, owner_emailed: emailed });
  } catch (e) { answer(res, e); }
});

router.post('/:businessId/abandon', requireAdmin, actionLimiter, async (req: any, res) => {
  const client = await clientOf(req, res);
  if (!client) return;
  const b = req.body ?? {};
  try {
    const r: any = await abandonDay(actorOf(req, client.id), { deviceId: b.device_id, businessDate: b.business_date, reason: b.reason, confirm: b.confirm === true });
    const reason = String(b.reason).trim();
    const dates = (r.days ?? []).map((d: any) => d.business_date).join(', ');
    const emailed = await afterAction(req, client, 'tills_days.abandon',
      `ZapTill support closed ${r.till}'s day for ${dates} as abandoned — reason: ${reason}`,
      `${(r.shifts ?? []).length} drawer(s) force-closed uncounted; sales the POS made after it last synced are not in it. Done by ${req.adminEmail}.`,
      { device_id: b.device_id, till: r.till, days: dates, shifts_force_closed: (r.shifts ?? []).length }, reason);
    res.json({ ...r, owner_emailed: emailed });
  } catch (e) { answer(res, e); }
});

export default router;
