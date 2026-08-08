import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { MAX_DISCOUNT_PCT } from '../lib/discountPolicy';

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
    { data: comboRows },
    { data: receiptTextRows },
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
    // Combo definitions. The till sells a combo as ONE line, but the dispatcher
    // and kitchen tickets must expand it into components — and each component
    // routes to the kitchen on its OWN category, so is_kitchen comes along.
    supabase
      .from('products')
      .select('id, combo_items!combo_id ( quantity, sort_order, product:product_id ( id, name, is_kitchen, categories ( is_kitchen ) ) )')
      .eq('business_id', req.businessId)
      .eq('is_combo', true)
      .eq('status', 'active'),
    // Owner-controlled receipt text. Lives in business_settings so it is set
    // once and reaches all three tills, rather than being retyped per device
    // and lost on reinstall.
    supabase
      .from('business_settings')
      .select('key, value')
      .eq('business_id', req.businessId)
      // kitchen_exclusions rides along with the receipt text because it is the
      // same shape of thing: owner-authored, per business, cached on every till.
      .in('key', ['receipt_header', 'receipt_footer', 'kitchen_exclusions']),
    supabase
      .from('branches')
      .select('id, desktop_licensed')
      .eq('business_id', req.businessId)
      .eq('is_main', true)
      .single(),
    supabase
      .from('businesses')
      .select('type, name, currency, vat_rate, ctl_rate')
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
  // Desktop-licence gate applies to the DESKTOP surface only. The web POS is
  // gated by web access at login (businesses.web_access_expires_at), NOT by a
  // per-branch desktop licence — so web tokens must not be blocked here.
  if (req.surface === 'desktop' && branch && !branch.desktop_licensed) {
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

  // combo_id -> ordered component list. Flattened here rather than in the till so
  // the desktop stores exactly what it prints and nothing has to understand
  // Supabase's nested join shape offline.
  const comboItems: Record<string, Array<{ product_id: string; name: string; quantity: number; is_kitchen: boolean }>> = {};
  for (const c of (comboRows ?? []) as any[]) {
    const items = (c.combo_items ?? [])
      .slice()
      .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((ci: any) => ({
        product_id: ci.product?.id ?? '',
        name:       ci.product?.name ?? '',
        quantity:   Number(ci.quantity ?? 1),
        // Product override wins; NULL falls back to the category. Written out
        // long-hand rather than with ?? because the override is a tri-state and
        // `false` must beat a kitchen category, not be treated as absent.
        is_kitchen: typeof ci.product?.is_kitchen === 'boolean'
          ? ci.product.is_kitchen
          : !!ci.product?.categories?.is_kitchen,
      }))
      .filter((i: any) => i.product_id);
    if (items.length) comboItems[c.id] = items;
  }

  // JSONB: a plain string arrives unwrapped, anything else is coerced.
  const receiptText: Record<string, string> = {};
  for (const r of (receiptTextRows ?? []) as any[]) {
    receiptText[r.key] = typeof r.value === 'string' ? r.value : String(r.value ?? '');
  }

  res.json({
    products: productsOut,
    comboItems,
    receiptHeader: receiptText.receipt_header ?? '',
    receiptFooter: receiptText.receipt_footer ?? '',
    // Things that must never reach a kitchen ticket — drinks, sauces, packaged
    // sides. Stated by the owner rather than inferred: a keyword guess is wrong
    // occasionally and silently, and the cook is the one who finds out.
    //
    // Per BUSINESS, not per terminal: "cole slaw is not cooked" is a fact about
    // the menu, and a second till must not disagree with the first.
    kitchenExclusions: (() => {
      const raw = receiptTextRows?.find((r: any) => r.key === 'kitchen_exclusions')?.value;
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === 'string') {
        try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map(String); } catch { /* not json */ }
        return raw.split(/[\r\n,]+/).map(t => t.trim()).filter(Boolean);
      }
      return [] as string[];
    })(),
    categories: categories ?? [],
    branchId: branch?.id ?? null,
    pricingBranchId,
    loyaltyEnabled: loyaltyFlag?.enabled ?? false,
    variantsByProduct,
    businessType: business?.type ?? 'retail',
    businessName: business?.name ?? '',
    currency: business?.currency ?? 'KES',
    // The desktop till used to hardcode 16. Send the real rate so it computes
    // and prints the tax this business actually charges — and so a
    // non-VAT-registered business (rate 0) gets no VAT line at all.
    vatRate: business?.vat_rate ?? null,
    // Catering/Tourism Levy. 0 or null = not applicable, and the till's
    // arithmetic collapses to VAT-only.
    ctlRate: business?.ctl_rate ?? 0,
    // The discount ceiling this server enforces on write. Sent so the till
    // clamps to the same number BEFORE it computes a total, takes cash and
    // prints a receipt — otherwise the paper, the drawer and the stored order
    // describe three different discounts and the difference surfaces as a cash
    // shortage nobody can trace.
    maxDiscountPct: MAX_DISCOUNT_PCT,
  });
});

export default router;
