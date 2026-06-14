import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';

const router = safeRouter();

const JWT_SECRET = process.env.JWT_SECRET!;

// The KDS tablet runs without a user session, so this route stays tokenless by
// design — but "scoped by branch_id" is only safe if every operation is
// actually constrained to that branch. Previously PATCH took a bare ticket id
// with no branch/business check, so anyone could advance ANY ticket in the
// database by guessing its UUID. We now:
//   1. Honour a SwiftPOS JWT when present (locks to the token's branch), and
//   2. Always verify the target ticket belongs to the resolved branch.
//
// FOLLOW-UP: issue the KDS tablet a dedicated branch-scoped token so branch_id
// stops being treated as a bearer capability.

function resolveBranch(req: any): { branchId: string | null; locked: boolean } {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(auth.slice(7), JWT_SECRET) as { isOwner?: boolean; branchId?: string | null };
      if (!p.isOwner && p.branchId) return { branchId: p.branchId, locked: true };
    } catch {
      // ignore — fall back to query/body branch_id
    }
  }
  const fromReq = (req.query.branch_id as string) || (req.body?.branch_id as string) || null;
  return { branchId: fromReq, locked: false };
}

// GET /api/kitchen/tickets
// Returns today's non-collected tickets for a branch, oldest first.
router.get('/tickets', async (req, res) => {
  const { branchId } = resolveBranch(req);
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }

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
    .eq('branch_id', branchId)
    .eq('orders.order_items.fire_status', 'fired')
    .neq('status', 'collected')
    .gte('created_at', todayStart.toISOString())
    .order('created_at', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

// PATCH /api/kitchen/tickets/:id/status
// Body: { status: 'preparing' | 'ready' | 'collected', branch_id }
router.patch('/tickets/:id/status', async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['preparing', 'ready', 'collected'];

  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  const { branchId } = resolveBranch(req);
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }

  // The ticket must belong to the resolved branch — prevents advancing a ticket
  // from another branch/tenant by guessing its id.
  const { data: ticket } = await supabase
    .from('kitchen_tickets')
    .select('id, branch_id')
    .eq('id', req.params.id)
    .single();

  if (!ticket || ticket.branch_id !== branchId) {
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
    .eq('branch_id', branchId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
