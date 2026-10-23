/**
 * lossAlerts.ts (routes) — A576: the Watch list and the owner's loss-prevention settings.
 *
 *   GET   /api/loss-alerts                 the watch list: alerts of the last 7 days (or ?days=1..31) not looked into yet,
 *                                          the most worth a look first, AT MOST 10. reports.voids, on the web only.
 *                                          A manager sees their branch's; the owner every branch (or the one picked);
 *                                          nobody is ever shown an alert about themselves.
 *   PATCH /api/loss-alerts/:id/dismiss     "Looked into" — off the list (who and when kept; an optional note).
 *   GET   /api/loss-alerts/settings        the owner's switches, thresholds and recipients, with the kinds that fit this
 *                                          business and what the data does not record yet. Owner only.
 *   PUT   /api/loss-alerts/settings        save them (cleaned: unknown keys dropped, numbers in range). Owner only.
 *
 * The owner, 2026-10-23: a warning for investigation, never an accusation; never on the cashier's screen — every route here
 * is the web dashboard's (requireWebSurface: a till's sign-in is refused) and holds reports.voids (a cashier's role does not).
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { requirePermission, branchScope } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import {
  cleanLossSettings, readLossSettings, topLoss, kindLabel, kindsFor, lossNeedsData, lossPrevDate, LOSS_DEFAULTS, LOSS_KINDS,
  LOSS_LIMITS, LOSS_TOP, type LossKind,
} from '../lib/lossAlertRules';
import { LOSS_SETTINGS_KEY } from '../jobs/lossAlerts';

const router = safeRouter();
router.use(requireAuth);
router.use(requireWebSurface);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function businessType(businessId: string): Promise<string | null> {
  const { data } = await supabase.from('businesses').select('type').eq('id', businessId).maybeSingle();
  return ((data as { type?: string | null } | null)?.type) ?? null;
}

/** The branches this caller's watch list covers: null = every branch (the owner's "All branches"). */
function scopeOf(req: any): { one: string | null; many: string[] | null } {
  const one = branchScope(req);
  if (one) return { one, many: null };
  if (req.isOwner) return { one: null, many: null };
  return { one: null, many: req.partnerBranches ?? [] };   // a partner of every branch: their branches
}

// GET /api/loss-alerts?days=7
router.get('/', requirePermission('reports.voids'), async (req, res) => {
  const days = Math.min(31, Math.max(1, parseInt(String(req.query.days ?? '7'), 10) || 7));
  const type = await businessType(req.businessId!);
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);   // EAT; the list is "the last N days"
  let q = supabase.from('loss_alerts')
    .select('id, kind, period, business_date, branch_id, staff_id, count, amount, peer_low, peer_high, score, message, link, notified_at, created_at')
    .eq('business_id', req.businessId).is('dismissed_at', null)
    .gte('business_date', lossPrevDate(today, days)).limit(500);
  const scope = scopeOf(req);
  if (scope.one) q = q.eq('branch_id', scope.one);
  else if (scope.many) q = q.in('branch_id', scope.many);
  const { data, error } = await q;
  if (error) {
    if (/loss_alerts/.test(error.message)) { res.json({ alerts: [], total: 0, top: LOSS_TOP, ready: false }); return; }   // before migration 166
    sendError(res, error); return;
  }
  const me = req.userId ? String(req.userId) : null;
  // Never an alert about the person reading it.
  const mine = ((data ?? []) as any[]).filter((r) => !(me && r.staff_id === me))
    .map((r) => ({ ...r, business_date: String(r.business_date).slice(0, 10), score: Number(r.score) || 0, count: Number(r.count) || 0 }));
  const top = topLoss(mine);
  const ids = [...new Set(top.flatMap((r) => [r.staff_id]).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: us } = await supabase.from('users').select('id, name').eq('business_id', req.businessId).in('id', ids);
    for (const u of (us ?? []) as any[]) names.set(u.id, u.name ?? '');
  }
  const bids = [...new Set(top.map((r) => r.branch_id).filter(Boolean))] as string[];
  const bnames = new Map<string, string>();
  if (bids.length) {
    const { data: bs } = await supabase.from('branches').select('id, name').eq('business_id', req.businessId).in('id', bids);
    for (const b of (bs ?? []) as any[]) bnames.set(b.id, b.name ?? '');
  }
  res.json({
    alerts: top.map((r) => ({
      id: r.id, kind: r.kind, label: LOSS_KINDS.includes(r.kind) ? kindLabel(r.kind as LossKind, type).label : r.kind,
      period: r.period, business_date: r.business_date, branch_id: r.branch_id, branch_name: r.branch_id ? (bnames.get(r.branch_id) ?? '') : '',
      staff_id: r.staff_id, staff_name: r.staff_id ? (names.get(r.staff_id) ?? '') : '', count: r.count,
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount), peer_low: r.peer_low, peer_high: r.peer_high,
      message: r.message, link: r.link, notified_at: r.notified_at,
    })),
    total: mine.length,
    top: LOSS_TOP,
    ready: true,
  });
});

// PATCH /api/loss-alerts/:id/dismiss  { note? }
router.patch('/:id/dismiss', requirePermission('reports.voids'), async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) { res.status(404).json({ error: 'Alert not found' }); return; }
  const { data: row, error } = await supabase.from('loss_alerts').select('id, branch_id, staff_id, dismissed_at')
    .eq('id', id).eq('business_id', req.businessId).maybeSingle();
  if (error) { sendError(res, error); return; }
  const scope = scopeOf(req);
  const r = row as any;
  const inScope = r && (scope.one ? r.branch_id === scope.one : scope.many ? scope.many.includes(r.branch_id) : true);
  if (!r || !inScope || (req.userId && r.staff_id === req.userId)) { res.status(404).json({ error: 'Alert not found' }); return; }
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  if (r.dismissed_at) { res.json({ ok: true, already: true }); return; }
  const { error: uErr } = await supabase.from('loss_alerts')
    .update({ dismissed_at: new Date().toISOString(), dismissed_by: req.userId && UUID.test(String(req.userId)) ? req.userId : null, dismiss_note: note || null })
    .eq('id', id).eq('business_id', req.businessId);
  if (uErr) { sendError(res, uErr); return; }
  res.json({ ok: true });
});

const ownerOnly = (req: any, res: any): boolean => {
  if (req.isOwner) return true;
  res.status(403).json({ error: 'Only the owner can change loss-prevention alerts.' });
  return false;
};

async function settingsView(businessId: string, stored: unknown) {
  const type = await businessType(businessId);
  const fits = new Set(kindsFor(type));
  return {
    settings: readLossSettings(stored),
    defaults: LOSS_DEFAULTS,
    limits: LOSS_LIMITS,
    kinds: LOSS_KINDS.filter((k) => fits.has(k)).map((k) => ({ kind: k, ...kindLabel(k, type) })),
    needs_data: lossNeedsData(type),
    business_type: type,
  };
}

// GET /api/loss-alerts/settings
router.get('/settings', async (req, res) => {
  if (!ownerOnly(req, res)) return;
  const { data, error } = await supabase.from('business_settings').select('value')
    .eq('business_id', req.businessId).eq('key', LOSS_SETTINGS_KEY).maybeSingle();
  if (error) { sendError(res, error); return; }
  res.json(await settingsView(req.businessId!, (data as any)?.value ?? null));
});

// PUT /api/loss-alerts/settings
router.put('/settings', async (req, res) => {
  if (!ownerOnly(req, res)) return;
  const clean = cleanLossSettings(req.body?.settings ?? req.body);
  if (!clean) { res.status(400).json({ error: 'Send the settings as an object.' }); return; }
  const { data: existing, error: rErr } = await supabase.from('business_settings').select('id')
    .eq('business_id', req.businessId).eq('key', LOSS_SETTINGS_KEY).maybeSingle();
  if (rErr) { sendError(res, rErr); return; }
  const nowIso = new Date().toISOString();
  const { error } = existing
    ? await supabase.from('business_settings').update({ value: clean, updated_at: nowIso }).eq('id', (existing as any).id)
    : await supabase.from('business_settings').insert({ business_id: req.businessId, key: LOSS_SETTINGS_KEY, value: clean });
  if (error) { sendError(res, error); return; }
  res.json(await settingsView(req.businessId!, clean));
});

export default router;
