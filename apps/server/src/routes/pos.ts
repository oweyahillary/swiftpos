import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();

router.use(requireAuth);

// GET /api/pos/init
// Fetches everything the POS screen needs to boot in a single round-trip:
// active products (with category colour), active categories, main branch id, and variant groups.
router.get('/init', async (req, res) => {
  // ── Which branch are we pricing for? ────────────────────────────────────────
  // Per-branch pricing (BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6): the till is bound
  // to one branch and sends it as ?branch_id. We resolve THAT branch's prices.
  // If absent (legacy callers) we fall back to the main branch below, so behaviour
  // is unchanged for anything not yet sending branch_id.
  const requestedBranchId =
    typeof req.query.branch_id === 'string' ? req.query.branch_id : null;

  const [
    { data: products, error: pErr },
    { data: categories, error: cErr },
    { data: branch, error: brErr },
    { data: business },
  ] = await Promise.all([
    supabase
      .from('products')
      .select('*, categories(name, color)')
      .eq('business_id', req.businessId)
      .eq('status', 'active'),
    supabase
      .from('categories')
      .select('*')
      .eq('business_id', req.businessId)
      .eq('status', 'active')
      .order('sort_order'),
    supabase
      .from('branches')
      .select('id, desktop_licensed')
      .eq('business_id', req.businessId)
      .eq('is_main', true)
      .single(),
    supabase
      .from('businesses')
      .select('type, name, currency')
      .eq('id', req.businessId)
      .single(),
  ]);

  if (pErr || cErr || brErr) {
    sendError(res, (pErr || cErr || brErr));
    return;
  }

  // ── Desktop branch licence check ──────────────────────────────────────────
  // The branch resolved above must have a paid desktop licence.
  // If it doesn't, the desktop app can't sync — blocks the POS at the data layer.
  // (PIN entry is also blocked in verify-pin, so this is defence-in-depth.)
  if (branch && !branch.desktop_licensed) {
    res.status(403).json({
      error: 'This branch does not have a desktop licence. Please contact SwiftPOS to activate.',
      code:  'BRANCH_NOT_LICENSED',
    });
    return;
  }

  // Fetch variant groups using the resolved product ID array (not a sub-query)
  const productIds = (products ?? []).map((p) => p.id);

  const [{ data: variantGroups, error: vErr }, { data: loyaltyFlag }] = await Promise.all([
    productIds.length > 0
      ? supabase
          .from('variant_groups')
          .select('*, variant_options(*)')
          .in('product_id', productIds)
          .order('sort_order')
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('feature_flags')
      .select('enabled')
      .eq('business_id', req.businessId)
      .eq('key', 'loyalty_enabled')
      .single(),
  ]);

  if (vErr) {
    sendError(res, vErr);
    return;
  }

  // Group variant_groups by product_id for fast client-side lookup
  const variantsByProduct: Record<string, typeof variantGroups> = {};
  (variantGroups ?? []).forEach((vg) => {
    if (!variantsByProduct[vg.product_id]) variantsByProduct[vg.product_id] = [];
    variantsByProduct[vg.product_id].push(vg);
  });

  // ── Per-branch price resolution ─────────────────────────────────────────────
  // Resolve the branch we're pricing for: the caller's branch_id if it belongs to
  // this business, otherwise the main branch (legacy/fallback). Then overlay each
  // product with branch_price (nullable). Effective price the client charges is
  // COALESCE(branch_price, base_price) — base_price stays the default.
  let pricingBranchId: string | null = branch?.id ?? null;
  if (requestedBranchId) {
    const { data: reqBranch } = await supabase
      .from('branches')
      .select('id')
      .eq('id', requestedBranchId)
      .eq('business_id', req.businessId)   // tenant guard — never price for another business
      .single();
    if (reqBranch) pricingBranchId = reqBranch.id;
  }

  const productsOut = products ?? [];
  if (pricingBranchId && productIds.length > 0) {
    const { data: branchPrices } = await supabase
      .from('branch_prices')
      .select('product_id, price')
      .eq('branch_id', pricingBranchId)
      .in('product_id', productIds);

    const priceByProduct: Record<string, number> = {};
    (branchPrices ?? []).forEach((bp: any) => { priceByProduct[bp.product_id] = bp.price; });

    for (const p of productsOut as any[]) {
      p.branch_price = priceByProduct[p.id] ?? null;   // null → client uses base_price
    }
  } else {
    for (const p of productsOut as any[]) p.branch_price = null;
  }

  res.json({
    products: productsOut,
    categories: categories ?? [],
    branchId: branch?.id ?? null,
    pricingBranchId,
    loyaltyEnabled: loyaltyFlag?.enabled ?? false,
    variantsByProduct,
    businessType: business?.type ?? 'retail',
    businessName: business?.name ?? '',
    currency: business?.currency ?? 'KES',
  });
});

export default router;
