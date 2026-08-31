import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { branchScope } from '../middleware/rbac';
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
router.use((req: any, res, next) => {
  // KDS displays present a long-lived, branch-scoped 'kds' SwiftPOS JWT; every other
  // caller uses a normal token. Accept a kds token HERE (kitchen routes only) and
  // derive its branch; delegate everyone else to requireAuth (which rejects kds
  // tokens, so a leaked KDS token is useless outside these endpoints).
  const authHeader = req.headers.authorization as string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(authHeader.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as any;
      if (p.surface === 'kds') {
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
  const token = jwt.sign(
    { businessId: req.businessId, branchId, isOwner: false, surface: 'kds', permissionKeys: [] },
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
        order_number, order_type,
        order_items ( product_name, quantity, notes, course, fire_status,
          order_item_variants ( variant_group_name, variant_option_name ),
          order_item_modifiers ( modifier_group_name, modifier_option_name )
        )
      )
    `)
    .eq('branch_id', scope.branchId)
    .eq('orders.order_items.fire_status', 'fired')
    .neq('status', 'collected')
    .gte('created_at', todayStart.toISOString())
    .order('created_at', { ascending: true });

  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
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
