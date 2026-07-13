import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Branch price up-sync (desktop manager PC → cloud)
//
// The manager (branch authority) edits prices locally on the desktop; those
// edits queue in local_price_edits and flush up here. Each edit is either:
//   • a SET   — { product_id, price }      → upsert branch_prices
//   • a CLEAR — { product_id, price: null } → delete the branch_prices row
//
// Authoritative metadata for the eventual two-way sync (newest-wins, §5 of
// BRANCH_AUTHORITY_AND_SYNC_DESIGN.md) is stamped here: updated_by='pc',
// updated_at = the edit's own time (so an offline edit keeps its real
// timestamp), and version is bumped so a later cloud write can be ordered.
//
// This endpoint only RECORDS the branch's intent; it does not gate on web
// access — that gating belongs to the sync-bridge step and applies uniformly to
// orders and prices. (Today, like orders, it accepts what the device sends.)
// ─────────────────────────────────────────────────────────────────────────────

interface PriceEditInput {
  product_id: string;
  price:      number | null;   // null = clear (revert to base_price)
  updated_at?: string;         // ISO; the edit's own time (offline-safe)
}

// POST /api/branch-prices/sync
// Body: { branch_id, edits: PriceEditInput[] }
// Returns: { ok, applied: string[], failed: { product_id, error }[] }
router.post('/sync', async (req, res) => {
  const { branch_id, edits } = req.body as { branch_id?: string; edits?: PriceEditInput[] };

  if (!branch_id || !Array.isArray(edits)) {
    res.status(400).json({ error: 'branch_id and edits[] are required' });
    return;
  }
  // Never let a device write prices for a branch it can't access / another tenant.
  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }
  if (edits.length === 0) { res.json({ ok: true, applied: [], failed: [] }); return; }
  if (edits.length > 1000) { res.status(413).json({ error: 'Too many edits in one batch' }); return; }

  const productIds = edits.map(e => e.product_id).filter(Boolean);

  // Validate every product belongs to this business (tenant guard).
  const { data: bizProducts, error: pErr } = await supabase
    .from('products').select('id')
    .eq('business_id', req.businessId).in('id', productIds);
  if (pErr) { sendError(res, pErr); return; }
  const validIds = new Set((bizProducts ?? []).map((p: { id: string }) => p.id));

  // Current versions, so we can bump rather than reset them.
  const { data: existing } = await supabase
    .from('branch_prices').select('product_id, version')
    .eq('branch_id', branch_id).in('product_id', productIds);
  const versionByProduct = new Map<string, number>(
    (existing ?? []).map((r: { product_id: string; version: number }) => [r.product_id, r.version]),
  );

  const applied: string[] = [];
  const failed:  { product_id: string; error: string }[] = [];

  const toUpsert: Array<{
    business_id: string; branch_id: string; product_id: string;
    price: number; updated_at: string; updated_by: string; version: number;
  }> = [];
  const toDelete: string[] = [];

  for (const e of edits) {
    if (!validIds.has(e.product_id)) {
      failed.push({ product_id: e.product_id, error: 'Unknown product for this business' });
      continue;
    }
    const when = e.updated_at && !Number.isNaN(Date.parse(e.updated_at))
      ? new Date(e.updated_at).toISOString()
      : new Date().toISOString();

    if (e.price === null || e.price === undefined) {
      toDelete.push(e.product_id);                                   // clear → remove override
    } else if (typeof e.price === 'number' && Number.isFinite(e.price) && e.price >= 0) {
      toUpsert.push({
        business_id: req.businessId,
        branch_id,
        product_id:  e.product_id,
        price:       e.price,
        updated_at:  when,
        updated_by:  'pc',
        version:     (versionByProduct.get(e.product_id) ?? 0) + 1,
      });
    } else {
      failed.push({ product_id: e.product_id, error: 'Invalid price' });
    }
  }

  if (toUpsert.length) {
    const { error } = await supabase
      .from('branch_prices')
      .upsert(toUpsert, { onConflict: 'branch_id,product_id' });
    if (error) { sendError(res, error); return; }
    applied.push(...toUpsert.map(u => u.product_id));
  }

  if (toDelete.length) {
    const { error } = await supabase
      .from('branch_prices').delete()
      .eq('branch_id', branch_id).in('product_id', toDelete);
    if (error) { sendError(res, error); return; }
    applied.push(...toDelete);
  }

  res.json({ ok: true, applied, failed });
});

export default router;
