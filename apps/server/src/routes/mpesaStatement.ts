/**
 * mpesaStatement.ts — the M-Pesa statement check (owner, 2026-11-05). Reports › M-Pesa statement reads the business's
 * statement in the browser (it never reaches the cloud) and matches it with @zaptill/core/mpesaStatement against the
 * sales its POS recorded as M-Pesa, which this route gives:
 *
 *   GET /api/payments/mpesa-statement/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&branch_id=
 *       the M-Pesa legs of completed payments in those Kenyan days (at most 31): the order's number, the code the POS
 *       kept (typed, tapped or from the M-Pesa prompt), the amount, when, the cashier and the branch.
 *
 * reports.payments (the owner, a manager given it, the Accountant), the caller's branch scope, the online licence (premium,
 * like M-Pesa payment notifications). Web only.
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth, requireWebSurface } from '../middleware/auth';
import { requirePermission, branchScope, oneBranchOnly } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { pageAll } from '../lib/pgQuery';
import { sendError } from '../lib/sendError';
import { dayRange } from '../lib/c2b';
import { c2bLicensed } from '../lib/c2bAccess';
import { businessDateEAT, businessRangeEAT } from '@zaptill/core/businessDay';
import type { MpesaSale } from '@zaptill/core/mpesaStatement';

const router = safeRouter();
router.use(requireAuth);
router.use(requireWebSurface);

export const STATEMENT_NOT_LICENSED = {
  error: 'The M-Pesa statement check is part of the ZapTill online licence — contact ZapTill to enable it.',
  code: 'STATEMENT_NOT_LICENSED',
} as const;

interface LegRow {
  amount: number | string; reference: string | null; created_at: string; branch_id: string;
  orders: { order_number: string | null; cashier_id: string | null } | null;
}

/** The rows as the browser's matcher takes them, with names for the cashier and the branch. */
export function toSales(rows: LegRow[], cashiers: Map<string, string>, branches: Map<string, string>): MpesaSale[] {
  return rows.map((r) => ({
    order_number: r.orders?.order_number ?? '',
    reference: r.reference,
    amount: Math.round(Number(r.amount) * 100) / 100,
    at: new Date(r.created_at).toISOString(),
    cashier: (r.orders?.cashier_id && cashiers.get(r.orders.cashier_id)) || null,
    branch: branches.get(r.branch_id) ?? null,
  }));
}

router.get('/sales', requirePermission('reports.payments'), async (req, res) => {
  if (oneBranchOnly(req, res)) return;
  if (!(await c2bLicensed(req.businessId!))) { res.status(403).json(STATEMENT_NOT_LICENSED); return; }
  const days = dayRange(req.query.from, req.query.to, businessDateEAT(new Date()));
  if (!days) { res.status(400).json({ error: 'A statement of up to 31 days can be checked at a time.', code: 'BAD_RANGE' }); return; }
  try {
    const range = businessRangeEAT(days.from, days.to);
    const branchId = branchScope(req);
    const rows = await pageAll<LegRow>(() => {
      let q = supabase.from('payments')
        .select('id, amount, reference, created_at, branch_id, orders!inner ( order_number, cashier_id )')
        .eq('business_id', req.businessId).eq('method', 'mpesa').eq('status', 'completed')
        .gte('created_at', range.start).lte('created_at', range.end);
      if (branchId) q = q.eq('branch_id', branchId);
      return q;
    }, 1000, 20_000);
    const cashierIds = [...new Set(rows.map((r) => r.orders?.cashier_id).filter(Boolean))] as string[];
    const [{ data: users }, { data: branchRows }] = await Promise.all([
      cashierIds.length
        ? supabase.from('users').select('id, name').eq('business_id', req.businessId).in('id', cashierIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
      supabase.from('branches').select('id, name').eq('business_id', req.businessId),
    ]);
    const cashiers = new Map((users ?? []).map((u: any) => [u.id as string, u.name as string]));
    const branches = new Map((branchRows ?? []).map((b: any) => [b.id as string, b.name as string]));
    res.json({ ...days, sales: toSales(rows, cashiers, branches) });
  } catch (e: any) {
    sendError(res, e, { message: 'Could not read the M-Pesa sales' });
  }
});

export default router;
