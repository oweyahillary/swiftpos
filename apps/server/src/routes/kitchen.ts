import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { branchScope, oneBranchOnly } from '../middleware/rbac';
import { supabase } from '../lib/supabase';

const JWT_SECRET = process.env.JWT_SECRET!;

const router = safeRouter();

// ── Auth ──────────────────────────────────────────────────────────────────────
// The KDS tablet must authenticate like any other station (a SwiftPOS JWT).
// branch_id is DERIVED from that token — never taken from the query/body — so it
// can no longer be used as a bearer capability to read or advance another
// branch's (or another tenant's) tickets by guessing a UUID.
//
//   • Staff tokens: locked to the token's branch_id.
//   • Owner tokens: may target any branch THEY own via ?branch_id=...
//
// Every branch is additionally verified to belong to the caller's business.
// A495: a KDS token is checked against its branch on every request — the token's version must be the branch's current
// kds_version (a newer token revokes it; migration 137), the branch must be active and the business not suspended.
// Returns the refusal, or null. Before migration 137 there is no column: every token reads as version 0.
async function kdsRefusal(p: { businessId?: string; branchId?: string; kdsVersion?: unknown }): Promise<{ status: number; error: string; code: string } | null> {
  if (!p.businessId || !p.branchId) return { status: 401, error: 'This kitchen display token names no branch', code: 'KDS_TOKEN_INVALID' };
  const read = (cols: string) => supabase.from('branches').select(cols).eq('id', p.branchId!).eq('business_id', p.businessId!).maybeSingle();
  let { data: branch, error } = await read('id, status, kds_version');
  if (error && /kds_version/.test(error.message ?? '')) ({ data: branch, error } = await read('id, status'));
  if (error) return { status: 503, error: 'Could not check this display right now — it retries', code: 'AUTH_BACKEND_UNAVAILABLE' };
  if (!branch) return { status: 401, error: 'This kitchen display\'s branch no longer exists', code: 'KDS_TOKEN_REVOKED' };
  const want = Number((branch as any).kds_version ?? 0);
  const have = Number.isInteger(p.kdsVersion) ? Number(p.kdsVersion) : 0;
  if (have !== want) return { status: 401, error: 'This kitchen display token was replaced — set the display up again', code: 'KDS_TOKEN_REVOKED' };
  if ((branch as any).status && (branch as any).status !== 'active') return { status: 403, error: 'This branch is closed', code: 'BRANCH_INACTIVE' };
  const { data: biz, error: bErr } = await supabase.from('businesses').select('status').eq('id', p.businessId).maybeSingle();
  if (bErr) return { status: 503, error: 'Could not check this display right now — it retries', code: 'AUTH_BACKEND_UNAVAILABLE' };
  if (!biz || (biz as any).status === 'suspended') return { status: 403, error: 'This business is suspended', code: 'BUSINESS_SUSPENDED' };
  return null;
}

router.use(async (req: any, res, next) => {
  // KDS displays present a long-lived, branch-scoped 'kds' SwiftPOS JWT; every other
  // caller uses a normal token. Accept a kds token HERE (kitchen routes only) and
  // derive its branch; delegate everyone else to requireAuth (which rejects kds
  // tokens, so a leaked KDS token is useless outside these endpoints).
  const authHeader = req.headers.authorization as string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(authHeader.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as any;
      if (p.surface === 'kds') {
        const refusal = await kdsRefusal(p);
        if (refusal) { res.status(refusal.status).json({ error: refusal.error, code: refusal.code }); return; }
        req.userId         = null;
        req.businessId     = p.businessId;
        req.branchId       = p.branchId ?? null;
        req.isOwner        = false;
        req.permissionKeys = [];
        req.surface        = 'kds';
        return next();
      }
    } catch {
      // not a kds token (or invalid) — fall through to normal auth
    }
  }
  return requireAuth(req, res, next);
});

// POST /api/kitchen/kds-token — an owner mints a long-lived, branch-scoped display
// token for a headless kitchen screen. It can read + advance ONLY that branch's
// kitchen tickets (confined by requireAuth rejecting surface:'kds' elsewhere).
router.post('/kds-token', async (req: any, res) => {
  if (!req.isOwner) { res.status(403).json({ error: 'Only an owner can create a KDS token' }); return; }
  const branchId = req.body?.branch_id;
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  const { data: branch } = await supabase
    .from('branches').select('id, name')
    .eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  // A495: a new token revokes every older one for this branch (migration 137). Before 137 the bump is not there: the
  // token is minted at version 0, as before, and nothing is revoked.
  const { data: bumped, error: bumpErr } = await supabase.rpc('bump_kds_version', { p_branch: branchId, p_business: req.businessId });
  let kdsVersion = 0;
  if (bumpErr) {
    if (!/bump_kds_version|kds_version/.test(bumpErr.message ?? '')) { sendError(res, bumpErr); return; }
    console.error('[kitchen] kds-token minted without revocation — apply migration 137:', bumpErr.message);
  } else {
    kdsVersion = Number(Array.isArray(bumped) ? (bumped[0] as any)?.bump_kds_version ?? bumped[0] : bumped);
    if (!Number.isInteger(kdsVersion)) { res.status(500).json({ error: 'Could not mint the display token' }); return; }
  }
  const token = jwt.sign(
    { businessId: req.businessId, branchId, isOwner: false, surface: 'kds', permissionKeys: [], kdsVersion },
    JWT_SECRET,
    { expiresIn: '365d' },
  );
  res.json({ token, branchId, branchName: branch.name });
});

// Resolve the branch to operate on and prove it belongs to the caller's business.
async function resolveScopedBranch(
  req: any,
): Promise<{ branchId: string | null; error?: string; status?: number }> {
  const branchId = branchScope(req); // owner: ?branch_id or null; staff: token branch
  if (!branchId) {
    return { branchId: null, error: 'branch_id is required', status: 400 };
  }
  // Confirm the branch is owned by this business — stops an owner token from
  // targeting a branch_id that belongs to another tenant.
  const { data: branch } = await supabase
    .from('branches')
    .select('id')
    .eq('id', branchId)
    .eq('business_id', req.businessId)
    .maybeSingle();
  if (!branch) {
    return { branchId: null, error: 'Branch not found', status: 404 };
  }
  return { branchId };
}

// GET /api/kitchen/tickets
// Returns today's non-collected tickets for the caller's (validated) branch.
router.get('/tickets', async (req, res) => {
  if (oneBranchOnly(req, res)) return;   // A582: one branch's kitchen at a time
  const scope = await resolveScopedBranch(req);
  if (!scope.branchId) { res.status(scope.status ?? 400).json({ error: scope.error }); return; }

  // Start of today in UTC
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('kitchen_tickets')
    .select(`
      id, order_id, station, status,
      created_at, preparing_at, ready_at, collected_at,
      orders (
        order_number, order_type, notes,
        order_items ( product_name, quantity, notes, course, fire_status,
          order_item_variants ( variant_group_name, variant_option_name ),
          order_item_modifiers ( modifier_group_name, modifier_option_name )
        )
      )
    `)
    .eq('branch_id', scope.branchId)
    .neq('status', 'collected')
    .gte('created_at', todayStart.toISOString())
    .order('created_at', { ascending: true });

  if (error) { sendError(res, error); return; }

  // Hide 'held' (unfired course) items in JS rather than with a two-levels-deep
  // embedded filter, which is fragile in PostgREST (it can error or drop the whole
  // ticket). Quick-sale items are 'fired' by default, so they always show; a ticket
  // left with nothing fired to cook is hidden until its course is fired.
  const tickets = (data ?? [])
    .map((t: any) => {
      const o = t.orders;
      if (o && Array.isArray(o.order_items)) {
        o.order_items = o.order_items.filter((oi: any) => oi.fire_status !== 'held');
      }
      return t;
    })
    .filter((t: any) => (t.orders?.order_items?.length ?? 0) > 0);

  res.json(tickets);
});

// PATCH /api/kitchen/tickets/:id/status
// Body: { status: 'preparing' | 'ready' | 'collected' }
router.patch('/tickets/:id/status', async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['preparing', 'ready', 'collected'];

  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  const scope = await resolveScopedBranch(req);
  if (!scope.branchId) { res.status(scope.status ?? 400).json({ error: scope.error }); return; }

  // The ticket must belong to the resolved (and business-verified) branch —
  // prevents advancing a ticket from another branch/tenant by guessing its id.
  const { data: ticket } = await supabase
    .from('kitchen_tickets')
    .select('id, branch_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!ticket || ticket.branch_id !== scope.branchId) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  const timestampField: Record<string, string> = {
    preparing: 'preparing_at',
    ready:     'ready_at',
    collected: 'collected_at',
  };

  const { data, error } = await supabase
    .from('kitchen_tickets')
    .update({ status, [timestampField[status]]: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('branch_id', scope.branchId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

export default router;
