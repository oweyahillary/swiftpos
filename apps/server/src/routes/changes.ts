/**
 * routes/changes.ts — A448: changes made on a till reach the cloud; a clash waits for the owner (lib/changeApply.ts).
 *
 *   POST /api/changes                  a till sends the changes it saved (up to 50, in the order made). Allowed for the till's
 *                                      own session (sent after the manager signed out — the maker's permission is checked)
 *                                      and for a manager's sign-in. Each answered applied / identical / awaiting / refused.
 *   GET  /api/changes/state?ids=a,b    where a till's changes stand (one waiting for the owner: approved, rejected)
 *   GET  /api/changes?status=awaiting  what waits for the owner (the owner, or changes.approve); /count = how many (A450)
 *   POST /api/changes/:id/decide       { approve: true|false } — the owner (or changes.approve)
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { can } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { cleanChange, describeChange } from '../lib/tillChanges';
import { applyChange, decideChange, type ChangeResult } from '../lib/changeApply';

const router = safeRouter();
router.use(requireAuth);

/** The owner, or a person holding changes.approve (A490) — never a till's own session (it is no person). */
const mayDecide = (req: any) => !req.isTill && can(req, 'changes.approve');

router.post('/', async (req, res) => {
  const list = Array.isArray(req.body?.changes) ? req.body.changes.slice(0, 50) : [];
  if (!list.length) { res.status(400).json({ error: 'changes is required' }); return; }
  const ctx = {
    businessId: req.businessId!, branchId: (req.headers['x-branch-id'] as string) || req.branchId || null,
    deviceId: String(req.headers['x-device-id'] ?? '') || req.deviceId || null,
    // A person signed in sends with their own keys; the till's own session (A415) carries none of a person's.
    callerKeys: req.isTill ? [] : (req.permissionKeys ?? []), callerIsOwner: !req.isTill && req.isOwner === true,
    callerUserId: req.isTill ? null : (req.userId ?? null),
  };
  const results: ChangeResult[] = [];
  for (const raw of list) {   // in order: a product's new category is created before the product names it
    const c = cleanChange(raw);
    if (!c.ok) { results.push({ id: String(raw?.id ?? ''), status: 'refused', message: (c as { error: string }).error }); continue; }
    results.push(await applyChange(ctx, (c as { change: any }).change));
  }
  res.json({ results });
});

router.get('/state', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100);
  if (!ids.length) { res.json([]); return; }
  const { data, error } = await supabase.from('change_requests').select('id, status, message, canonical_id, decided_by_name, decided_at')
    .eq('business_id', req.businessId).in('id', ids);
  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

/** How many wait for the owner — the badge on the web's Approvals link. 0 (not 403) for anyone who does not decide. */
router.get('/count', async (req, res) => {
  if (!mayDecide(req)) { res.json({ count: 0 }); return; }
  const { count, error } = await supabase.from('change_requests').select('id', { count: 'exact', head: true })
    .eq('business_id', req.businessId).eq('status', 'awaiting');
  if (error) { sendError(res, error); return; }
  res.json({ count: count ?? 0 });
});

router.get('/', async (req, res) => {
  if (!mayDecide(req)) { res.status(403).json({ error: 'Only the owner decides changes' }); return; }
  const status = String(req.query.status ?? 'awaiting');
  const { data, error } = await supabase.from('change_requests')
    .select('id, entity, entity_id, op, base, proposed, cloud_value, status, message, canonical_id, made_by_name, made_at, device_id, branch_id, received_at, decided_by_name, decided_at')
    .eq('business_id', req.businessId).eq('status', status).order('received_at', { ascending: false }).limit(200);
  if (error) { sendError(res, error); return; }
  res.json((data ?? []).map((r: any) => ({ ...r, summary: describeChange({ entity: r.entity, op: r.op, data: r.proposed ?? {} }, r.proposed?.name ?? r.cloud_value?.name) })));
});

router.post('/:id/decide', async (req, res) => {
  if (!mayDecide(req)) { res.status(403).json({ error: 'Only the owner decides changes' }); return; }
  if (typeof req.body?.approve !== 'boolean') { res.status(400).json({ error: 'approve must be true or false' }); return; }
  const { data: me } = req.userId ? await supabase.from('users').select('name').eq('id', req.userId).maybeSingle() : { data: null };
  const r = await decideChange(req.businessId!, req.params.id, req.body.approve, { id: req.userId ?? null, name: (me as any)?.name ?? null });
  if (!r.ok) { res.status(r.error === 'not found' ? 404 : 409).json({ error: r.error }); return; }
  res.json({ ok: true, status: r.status });
});

export default router;
