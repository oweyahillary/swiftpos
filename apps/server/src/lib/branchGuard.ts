/**
 * branchGuard.ts — A494: one check that a branch id from a request is this business's AND the caller's.
 *
 * assertBranchAccess (middleware/rbac.ts) lets the owner name ANY id — the owner's own branches, but also another
 * business's or a made-up one. A write that keys a row by branch alone (stock_levels, ingredient_stock_levels,
 * etims_branch_config, stock_movements) must also know the branch is this business's, or an owner's token reaches
 * another tenant's rows. Reads filtered by business_id are safe without it; writes and branch-keyed reads are not.
 */
import type { Request, Response } from 'express';
import { supabase } from './supabase';
import { assertBranchAccess } from '../middleware/rbac';

/** Is `branchId` one of `businessId`'s branches? Never throws (an error reads as "no"). */
export async function branchOfBusiness(businessId: string, branchId: string | null | undefined): Promise<boolean> {
  if (!businessId || !branchId || typeof branchId !== 'string') return false;
  try {
    const { data } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', businessId).maybeSingle();
    return !!data;
  } catch { return false; }
}

/**
 * The caller may act at this branch (assertBranchAccess) and it is this business's. Answers the request itself (403 /
 * 404) and returns false when not.
 */
export async function guardBranch(req: Request, res: Response, branchId: string | null | undefined,
  forbidden = 'No access to that branch'): Promise<boolean> {
  if (!branchId || typeof branchId !== 'string') { res.status(400).json({ error: 'branch_id is required' }); return false; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: forbidden }); return false; }
  if (!(await branchOfBusiness(req.businessId, branchId))) { res.status(404).json({ error: 'Branch not found in this business' }); return false; }
  return true;
}

/** Every id in `ids` is a row of `table` with this business_id. Empty / absent → true. Never throws. */
export async function idsOfBusiness(table: string, businessId: string, ids: Array<string | null | undefined>): Promise<boolean> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (!want.length) return true;
  if (ids.some((x) => x !== null && x !== undefined && typeof x !== 'string')) return false;
  try {
    const found = new Set<string>();
    for (let i = 0; i < want.length; i += 200) {
      const { data, error } = await supabase.from(table).select('id').eq('business_id', businessId).in('id', want.slice(i, i + 200));
      if (error) return false;
      for (const r of (data ?? []) as Array<{ id: string }>) found.add(r.id);
    }
    return want.every((id) => found.has(id));
  } catch { return false; }
}
