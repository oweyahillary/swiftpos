import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = safeRouter();

router.use(requireAuth);

// GET /api/pos/init
// Fetches everything the POS screen needs to boot in a single round-trip:
// active products (with category colour), active categories, main branch id, and variant groups.
router.get('/init', async (req, res) => {
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
    res.status(500).json({ error: (pErr || cErr || brErr)?.message });
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
    res.status(500).json({ error: vErr.message });
    return;
  }

  // Group variant_groups by product_id for fast client-side lookup
  const variantsByProduct: Record<string, typeof variantGroups> = {};
  (variantGroups ?? []).forEach((vg) => {
    if (!variantsByProduct[vg.product_id]) variantsByProduct[vg.product_id] = [];
    variantsByProduct[vg.product_id].push(vg);
  });

  res.json({
    products: products ?? [],
    categories: categories ?? [],
    branchId: branch?.id ?? null,
    loyaltyEnabled: loyaltyFlag?.enabled ?? false,
    variantsByProduct,
    businessType: business?.type ?? 'retail',
    businessName: business?.name ?? '',
    currency: business?.currency ?? 'KES',
  });
});

export default router;
