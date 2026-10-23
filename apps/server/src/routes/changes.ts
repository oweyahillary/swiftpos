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
import { can, branchFilter, rowInBranches, type BranchFilter } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { cleanChange, describeChange } from '../lib/tillChanges';
import { applyChange, decideChange, type ChangeResult } from '../lib/changeApply';
import { isNodeRole } from '../lib/deviceRegistry';   // A522

const router = safeRouter();
router.use(requireAuth);

/** A582: whose changes a reader sees — a partner of some branches: theirs (a set), whatever branch is picked; else all. */
function partnerChangeScope(req: any): BranchFilter {
  const f = branchFilter(req);
  if (f.kind === 'set') return f;
  if (req.webPartner === true && !req.allBranches) return { kind: 'set', ids: [...(req.partnerBranches ?? [])] };
  return { kind: 'all' };
}

/** The owner, or a person holding changes.approve (A490) — never a till's own session (it is no person). */
const mayDecide = (req: any) => !req.isTill && can(req, 'changes.approve');

router.post('/', async (req, res) => {
  const list = Array.isArray(req.body?.changes) ? req.body.changes.slice(0, 50) : [];
  if (!list.length) { res.status(400).json({ error: 'changes is required' }); return; }
  // A494: the branch is the session's own — a till's (its token), a manager's (their token) — never a header they send.
  // Only the owner names one (X-Branch-Id, the dashboard's selector), and it must be a branch of the business.
  let branchId: string | null = null;
  if (req.isTill) {
    branchId = req.branchId ?? null;
    if (!branchId && req.deviceId) {
      const { data: dev, error: dErr } = await supabase.from('user_devices').select('branch_id')
        .eq('business_id', req.businessId).eq('device_id', req.deviceId).maybeSingle();
      if (dErr) { sendError(res, dErr); return; }
      branchId = (dev as { branch_id?: string | null } | null)?.branch_id ?? null;
    }
  } else if (req.isOwner) {
    const asked = String(req.headers['x-branch-id'] ?? '').trim() || null;
    if (asked) {
      const { data: br, error: bErr } = await supabase.from('branches').select('id').eq('id', asked).eq('business_id', req.businessId).maybeSingle();
      if (bErr) { sendError(res, bErr); return; }
      if (!br) { res.status(400).json({ error: "That branch is not one of this business's", code: 'BRANCH_NOT_FOUND' }); return; }
    }
    branchId = asked;
  } else {
    branchId = req.branchId ?? null;
  }
  // A522 (for A521 — a staff / PIN change made on a till that was offline, relayed by its branch server): `relayed_for`
  // names the till it was made on, recorded as the change's device — ONLY when this session is a branch server's own
  // (a till session whose device serves its branch, isNodeRole) and that till is a device of the same branch. Anything
  // else keeps the session's own id. The maker's proof (any till of the branch, makerSignedInHere) and rights are unchanged.
  let relayedFor: string | null = null;
  const askedRelay = typeof req.body?.relayed_for === 'string' ? req.body.relayed_for.trim().slice(0, 64) : '';
  if (req.isTill && req.deviceId && askedRelay && askedRelay !== req.deviceId) {
    const { data: devs, error: rErr } = await supabase.from('user_devices').select('device_id, branch_id, device_role')
      .eq('business_id', req.businessId).in('device_id', [req.deviceId, askedRelay]);
    if (rErr) { sendError(res, rErr); return; }
    const me = (devs ?? []).find((d: any) => d.device_id === req.deviceId) as { branch_id?: string | null; device_role?: string | null } | undefined;
    const them = (devs ?? []).find((d: any) => d.device_id === askedRelay) as { branch_id?: string | null } | undefined;
    if (me && them && isNodeRole(me.device_role ?? null) && me.branch_id && them.branch_id === me.branch_id) relayedFor = askedRelay;
  }
  const ctx = {
    businessId: req.businessId!, branchId,
    // A494: the till's own id from its token; a person's header is only recorded (it proves nothing).
    deviceId: req.isTill ? (relayedFor ?? req.deviceId) : (String(req.headers['x-device-id'] ?? '').split(',')[0].trim() || null),
    // A person signed in sends with their own keys — and is who made it (a made_by in the body is never believed for a
    // person); the till's own session (A415) carries none of a person's: the maker must be proven (lib/changeApply.ts).
    callerKeys: req.isTill ? [] : (req.permissionKeys ?? []), callerIsOwner: !req.isTill && req.isOwner === true,
    callerUserId: req.isTill ? null : (req.userId ?? null),
    tillSession: req.isTill === true,
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
  // A582: a partner of some branches (in a set, or at one of theirs) — the changes made at their branches (and the
  // business-wide ones), never another branch's
  const f = partnerChangeScope(req);
  if (f.kind === 'set') {
    const { data, error } = await supabase.from('change_requests').select('id, branch_id')
      .eq('business_id', req.businessId).eq('status', 'awaiting').limit(5000);
    if (error) { sendError(res, error); return; }
    res.json({ count: ((data ?? []) as Array<{ branch_id: string | null }>).filter((r) => rowInBranches(f, r.branch_id, true)).length });
    return;
  }
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
  const f = partnerChangeScope(req);   // A582: a partner of some branches — their branches' changes and the business-wide ones
  res.json((data ?? []).filter((r: any) => f.kind !== 'set' || rowInBranches(f, r.branch_id, true)).map((r: any) => ({ ...r, summary: describeChange({ entity: r.entity, op: r.op, data: r.proposed ?? {} }, r.proposed?.name ?? r.cloud_value?.name) })));
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
