import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import type { DbProduct, DbVariantGroup, DbModifierGroup, OrderItemInput, PaymentLegInput, DbOrder, DbPayment, DbCustomer } from '../lib/dbTypes';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { fireWebhook } from '../lib/webhooks';
import { requireAuth } from '../middleware/auth';
import { branchScope, requirePermission, assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { getTier } from './loyalty';
import { checkLowStock, checkLowIngredients } from '../jobs/lowStockChecker';
import { fiscaliseInvoice, fiscaliseCreditNote } from '../lib/etims';
import { sendReceiptWhatsApp } from '../lib/whatsapp';

const router = safeRouter();
router.use(requireAuth);

// Round to 2 dp (money) avoiding binary-float drift.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Verifies a supervisor PIN against the bcrypt hash stored in business_settings
// (key: supervisor_pin_hash). Falls back to a legacy plaintext supervisor_pin
// row for installs predating hashing. Returns 'not_configured' if neither set.
async function verifySupervisorPin(
  businessId: string,
  pin?: string,
): Promise<boolean | 'not_configured'> {
  const { data: hashRow } = await supabase
    .from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', 'supervisor_pin_hash').maybeSingle();

  let hash = hashRow?.value as string | undefined;
  if (typeof hash === 'string') { try { hash = JSON.parse(hash); } catch { /* already raw */ } }

  if (hash) {
    if (!pin) return false;
    return bcrypt.compare(String(pin), String(hash));
  }

  // Legacy plaintext fallback (re-saving the PIN will migrate it to a hash).
  const { data: legacy } = await supabase
    .from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', 'supervisor_pin').maybeSingle();

  let expected = legacy?.value as string | undefined;
  if (typeof expected === 'string') { try { expected = JSON.parse(expected); } catch { /* already raw */ } }
  if (expected === undefined || expected === null || expected === '') return 'not_configured';
  if (!pin) return false;

  const a = Buffer.from(String(pin));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Verify a per-user override authorizer for a privileged action (e.g. voiding a
// paid order). Looks up active staff in the business who have an override PIN
// configured and bcrypt-compares the entered PIN.
//   - If `authorizerId` is supplied (supervisor picked from a list), only that
//     user is checked, giving an unambiguous audit trail.
//   - Returns { ok:true, userId } on success.
//   - Returns reason 'no_authorizers' when nobody has an override PIN set, so the
//     caller can fall back to the legacy business-wide supervisor PIN.
async function verifyOverrideAuthorizer(
  businessId:   string,
  authorizerId: string | undefined,
  pin:          string | undefined,
): Promise<{ result: 'ok' | 'invalid' | 'no_authorizers'; userId?: string }> {
  const { data: authorizers } = await supabase
    .from('users')
    .select('id, override_pin_hash')
    .eq('business_id', businessId)
    .eq('status', 'active')
    .not('override_pin_hash', 'is', null);

  if (!authorizers || authorizers.length === 0) {
    return { result: 'no_authorizers' };
  }
  if (!pin) return { result: 'invalid' };

  const candidates = authorizerId
    ? authorizers.filter((a: any) => a.id === authorizerId)
    : authorizers;

  for (const a of candidates as any[]) {
    if (a.override_pin_hash && await bcrypt.compare(String(pin), String(a.override_pin_hash))) {
      return { result: 'ok', userId: a.id };
    }
  }
  return { result: 'invalid' };
}

// ── Authoritative order pricing (shared by POST / and POST /open) ────────────
// Rebuilds every line from the catalogue so client-sent prices/totals can't be
// trusted. Mutates each line's selectedVariants[].priceAdjustment and
// selectedModifiers[].price to the authoritative DB values (so denormalised
// display rows stay truthful). Returns computed money or a structured error.
type RecomputeResult =
  | { ok: true; lines: { unitPrice: number; lineTotal: number }[]; subtotal: number; discount: number; total: number; vat: number }
  | { ok: false; status: number; error: string };

async function recomputeOrderTotals(
  businessId: string,
  branchId: string,
  items: OrderItemInput[],
  discountAmount: number | string,
): Promise<RecomputeResult> {
  const vKey = (pid: string, g: string, o: string) => `${pid}::${g}::${o}`;
  const lineProductIds: string[] = items
    .map(i => i?.product?.id ?? null)
    .filter((x): x is string => !!x);

  const basePriceMap = new Map<string, number>();
  const variantAdjMap = new Map<string, number>();
  const variantAdjById = new Map<string, number>();
  const modifierPriceMap = new Map<string, number>();

  if (lineProductIds.length) {
    const { data: bizProducts } = await supabase
      .from('products').select('id, base_price')
      .eq('business_id', businessId).in('id', lineProductIds);
    (bizProducts ?? [] as Pick<DbProduct, 'id' | 'base_price'>[]).forEach(p => basePriceMap.set(p.id, Number(p.base_price)));

    // Per-branch pricing: overlay this branch's price overrides on top of the
    // base prices. Still authoritative (server-resolved, not client-trusted) —
    // we just resolve the SAME effective price the till charged
    // (COALESCE(branch_price, base_price)) instead of always the default.
    // See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6.
    if (branchId) {
      const { data: branchPrices } = await supabase
        .from('branch_prices').select('product_id, price')
        .eq('branch_id', branchId).in('product_id', lineProductIds);
      (branchPrices ?? []).forEach((bp: { product_id: string; price: string | number }) =>
        basePriceMap.set(bp.product_id, Number(bp.price)));
    }

    const { data: vgroups } = await supabase
      .from('variant_groups')
      .select('name, product_id, variant_options ( id, name, price_adjustment )')
      .in('product_id', lineProductIds);
    (vgroups ?? [] as Array<{ name: string; product_id: string; variant_options: Array<{ id: string; name: string; price_adjustment: string }> }>).forEach(g =>
      (g.variant_options ?? []).forEach((o: any) => {
        variantAdjMap.set(vKey(g.product_id, g.name, o.name), Number(o.price_adjustment));
        if (o.id) variantAdjById.set(String(o.id), Number(o.price_adjustment));
      }));

    const { data: mgroups } = await supabase
      .from('modifier_groups')
      .select('name, product_id, modifier_options ( name, price )')
      .in('product_id', lineProductIds);
    (mgroups ?? [] as Array<{ name: string; product_id: string; modifier_options: Array<{ name: string; price: string }> }>).forEach(g =>
      (g.modifier_options ?? []).forEach(o =>
        modifierPriceMap.set(vKey(g.product_id, g.name, o.name), Number(o.price))));
  }

  const lines: { unitPrice: number; lineTotal: number }[] = [];
  for (const item of items) {
    const pid: string | null = item?.product?.id ?? null;
    const qty = Number(item.quantity) || 0;

    if (pid) {
      if (!basePriceMap.has(pid)) {
        return { ok: false, status: 400, error: 'Order contains a product that does not belong to this business' };
      }
      let unit = Math.max(0, basePriceMap.get(pid)!);   // never let a negative product price reduce the bill
      for (const v of (item.selectedVariants ?? [])) {
        // Accept both the canonical shape ({groupName, optionName}) and the
        // raw-option shape ({id/optionId, name}) some clients send.
        const vv = v as any;
        let adj = variantAdjMap.get(vKey(pid, vv.groupName, vv.optionName));
        if (adj === undefined) adj = variantAdjById.get(String(vv.optionId ?? vv.id ?? ''));
        if (adj === undefined) {
          const label = vv.groupName || vv.optionName || vv.name || vv.id || 'unknown';
          return { ok: false, status: 400, error: `Unknown variant: ${label}` };
        }
        v.priceAdjustment = adj;
        unit += adj;
      }
      let modifierTotal = 0;
      for (const m of (item.selectedModifiers ?? [])) {
        const price = modifierPriceMap.get(vKey(pid, m.groupName, m.optionName));
        if (price === undefined) return { ok: false, status: 400, error: `Unknown modifier: ${m.groupName} / ${m.optionName}` };
        m.price = price;
        modifierTotal += price;
      }
      lines.push({ unitPrice: round2(unit), lineTotal: round2((unit + modifierTotal) * qty) });
    } else {
      // Non-catalogue charge (parking/fuel/quick-add) — trust client price, clamped >= 0.
      const unit = Math.max(0, Number(item.unitPrice) || 0);
      const modifierTotal = (item.selectedModifiers ?? [])
        .reduce((s: number, m: { price?: number | string }) => s + Math.max(0, Number(m.price) || 0), 0);
      lines.push({ unitPrice: round2(unit), lineTotal: round2((unit + modifierTotal) * qty) });
    }
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const discount = round2(Math.min(Math.max(0, Number(discountAmount) || 0), subtotal));
  const total = round2(subtotal - discount);

  const { data: bizRow } = await supabase
    .from('businesses').select('vat_rate').eq('id', businessId).single();
  const vatRate = Number(bizRow?.vat_rate ?? 16);
  const vat = round2(total - total / (1 + vatRate / 100)); // VAT-inclusive prices

  return { ok: true, lines, subtotal, discount, total, vat };
}

// ── Loyalty helpers ──────────────────────────────────────────

async function getLoyaltyEarnRate(businessId: string): Promise<number> {
  const { data } = await supabase
    .from('business_settings')
    .select('value')
    .eq('business_id', businessId)
    .eq('key', 'loyalty_earn_rate')
    .single();
  return (data?.value as number) ?? 1; // default 1 pt per KES 10
}

// Awards points after a completed order.
// pointsToEarn already accounts for tier multiplier (computed by caller).
async function awardLoyaltyPoints(
  customerId: string,
  businessId: string,
  orderId: string,
  pointsToEarn: number,
  orderNumber: string,
) {
  // Atomic increment — avoids race condition when concurrent orders for the same customer
  // are placed simultaneously (read-then-write can miscalculate points under concurrency).
  const { error } = await supabase.rpc('increment_loyalty_points', {
    p_customer_id: customerId,
    p_delta:       pointsToEarn,
  });

  // Fallback to read-then-write if the RPC doesn't exist yet (pre-migration environments)
  if (error?.message?.includes('function') || error?.message?.includes('does not exist')) {
    const { data: customer } = await supabase
      .from('customers')
      .select('loyalty_points, visit_count')
      .eq('id', customerId)
      .single();

    if (customer) {
      await supabase
        .from('customers')
        .update({
          loyalty_points: (customer.loyalty_points ?? 0) + pointsToEarn,
          visit_count:    (customer.visit_count ?? 0) + 1,
        })
        .eq('id', customerId);
    }
  }

  await supabase
    .from('loyalty_transactions')
    .insert({
      customer_id: customerId,
      business_id: businessId,
      order_id:    orderId,
      type:        'earn',
      points:      pointsToEarn,
      notes:       `Earned on order ${orderNumber}`,
    });
}

// POST /api/orders
// Creates order, order_items, order_item_variants, order_item_modifiers, payment,
// deducts stock, creates kitchen ticket, and handles loyalty earn/redeem.
router.post('/', async (req, res) => {
  // Idempotency — the desktop sync engine (and any retrying client) sends
  // X-Idempotency-Key. If we've already created an order for this key, return
  // the existing one with 200 instead of creating a duplicate. This makes a
  // lost-response retry safe.
  const idempotencyKey = (req.header('X-Idempotency-Key') || req.body?.idempotency_key || '').trim();
  if (idempotencyKey) {
    const { data: existing } = await supabase
      .from('orders')
      .select('id, order_number')
      .eq('business_id', req.businessId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing) {
      res.status(200).json({ orderId: existing.id, orderNumber: existing.order_number, duplicate: true });
      return;
    }
  }

  const {
    branch_id,
    order_number,
    order_type = 'retail',
    subtotal,
    vat_amount,
    total,
    items,
    payment,   // legacy single-payment (kept for backwards compat)
    payments,  // new: array of payment legs for split support
    // Loyalty (all optional)
    customer_id,
    customer_name,
    customer_phone,
    points_redeemed = 0,
    discount_amount = 0,
    discount_id = null,
    shift_id = null,
    tip_amount = 0,
  } = req.body;

  // Normalise to array — support both old single `payment` and new `payments` array
  const paymentLegs: PaymentLegInput[] = Array.isArray(payments) && payments.length > 0
    ? payments
    : payment
      ? [payment]
      : [];

  if (!branch_id || !order_number || !items?.length || !paymentLegs.length) {
    const missing = [
      !branch_id && 'branch_id',
      !order_number && 'order_number',
      !items?.length && 'items',
      !paymentLegs.length && 'payment',
    ].filter(Boolean).join(', ');
    res.status(400).json({ error: `Missing required fields: ${missing}` });
    return;
  }

  // Item 5: a staff member locked to one branch must not create orders (and
  // deduct stock) against another branch by passing a different branch_id.
  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }

  try {
    // Item 7: ensure any attached customer belongs to THIS business — prevents
    // reading/redeeming another tenant's loyalty balance via a known UUID.
    if (customer_id) {
      const { data: cust } = await supabase
        .from('customers').select('id').eq('id', customer_id).eq('business_id', req.businessId).maybeSingle();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
    }

    // 1. Validate redeemed points if a customer is attached
    if (customer_id && points_redeemed > 0) {
      const { data: customer } = await supabase
        .from('customers')
        .select('loyalty_points')
        .eq('id', customer_id)
        .eq('business_id', req.businessId)
        .single();

      if (!customer || customer.loyalty_points < points_redeemed) {
        res.status(400).json({ error: 'Insufficient loyalty points' });
        return;
      }
    }

    // ── Item 4: authoritative price recomputation (anti-tampering) ───────────
    const recomputed = await recomputeOrderTotals(req.businessId, branch_id, items, discount_amount);
    if (!recomputed.ok) { res.status(recomputed.status).json({ error: recomputed.error }); return; }
    const {
      lines: authLines,
      subtotal: authSubtotal,
      discount: authDiscount,
      total: authTotal,
      vat: authVat,
    } = recomputed;

    // ── L5: a client-supplied discount_id must belong to this business ───────
    // Prevents referencing (and incrementing usage on) another tenant's discount.
    // NOTE: the manual discount_amount is still trusted here, clamped to
    // [0, subtotal] by recomputeOrderTotals. Gating who may apply a manual
    // discount, or re-deriving the amount from the discount record, is a product
    // decision left to you (see PATCH_NOTES).
    if (discount_id) {
      const { data: disc } = await supabase
        .from('discounts')
        .select('id')
        .eq('id', discount_id)
        .eq('business_id', req.businessId)
        .maybeSingle();
      if (!disc) { res.status(400).json({ error: 'Invalid discount' }); return; }
    }

    // ── Credit sale pre-check (item 15) ──────────────────────────────────────
    // If any payment leg uses 'credit', a customer is required and their
    // available credit must cover the credit portion. Checked BEFORE the order
    // is created so we never commit a sale that breaches the limit.
    const creditLeg = paymentLegs.find(l => l.method === 'credit');
    if (creditLeg) {
      if (!customer_id) {
        res.status(400).json({ error: 'A customer is required for a credit sale' });
        return;
      }
      const creditAmount = Number(creditLeg.amount) || 0;
      const { data: cust } = await supabase
        .from('customers')
        .select('credit_limit, credit_balance')
        .eq('id', customer_id).eq('business_id', req.businessId).single();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
      const available = Number(cust.credit_limit) - Number(cust.credit_balance);
      if (creditAmount > available) {
        res.status(400).json({
          error: `Credit limit exceeded. Available: ${available.toFixed(2)}, required: ${creditAmount.toFixed(2)}`,
        });
        return;
      }
    }

    // 2. Create order
    // If the client didn't supply a shift, attach the cashier's current open shift.
    // Otherwise the order's cash lands in the Z-report payment breakdown but not in
    // the per-shift cash reconciliation (which filters by shift_id) — the exact-gap bug.
    let resolvedShiftId: string | null = shift_id ?? null;
    if (!resolvedShiftId && req.userId) {
      const { data: openShift } = await supabase
        .from('shifts')
        .select('id')
        .eq('business_id', req.businessId)
        .eq('cashier_id', req.userId)
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openShift) resolvedShiftId = (openShift as { id: string }).id;
    }

    const { data: order, error: oErr } = await supabase
      .from('orders')
      .insert({
        business_id: req.businessId,
        branch_id,
        customer_id: customer_id ?? null,
        customer_name: customer_name ?? null,
        customer_phone: customer_phone ?? null,
        order_number,
        order_type,
        status: 'completed',
        subtotal: authSubtotal,
        vat_amount: authVat,
        discount_amount: authDiscount,
        discount_id: discount_id ?? null,
        loyalty_points_used: points_redeemed,
        total: authTotal,
        tip_amount: Math.max(0, Number(tip_amount) || 0),
        shift_id: resolvedShiftId,
        // Set seated_at for dine-in so the turnover report (which requires it) sees
        // pay-first orders — previously only the order-first /open path set this.
        seated_at: order_type === 'dine_in' ? new Date().toISOString() : null,
        idempotency_key: idempotencyKey || null,
        cashier_id:      req.userId ?? null,
        device_id:       req.body?.device_id ?? null,
        sync_status: 'pending',
      })
      .select()
      .single();

    if (oErr) throw oErr;

    // 3. Order items
    const { data: orderItems, error: iErr } = await supabase
      .from('order_items')
      .insert(
        items.map((item: OrderItemInput, idx: number) => ({
          order_id: order.id,
          product_id: item.product?.id ?? null,
          product_name: item.product?.name ?? (item as any).product_name ?? 'Item',
          category_name: Array.isArray(item.product?.categories)
            ? (item.product.categories[0]?.name ?? null)
            : ((item.product as any)?.categories?.name ?? (item as any).category_name ?? null),
          unit_price: authLines[idx].unitPrice,
          quantity: item.quantity,
          subtotal: authLines[idx].lineTotal,
          notes: item.notes ?? null,
        }))
      )
      .select();

    if (iErr) throw iErr;

    // 4. Variants + modifiers
    const variantRows: Array<{ order_item_id: string; group_name: string; option_name: string; price_adjustment: number }> = [];
    const modifierRows: Array<{ order_item_id: string; group_name: string; option_name: string; price: number }> = [];

    items.forEach((item: OrderItemInput, idx: number) => {
      const orderItemId = orderItems[idx].id;
      (item.selectedVariants ?? []).forEach((v: { groupName: string; optionName: string; priceAdjustment?: number; id?: string }) => {
        variantRows.push({
          order_item_id: orderItemId,
          variant_group_name: v.groupName,
          variant_option_name: v.optionName,
          price_adjustment: v.priceAdjustment,
        });
      });
      (item.selectedModifiers ?? []).forEach((m: { groupName: string; optionName: string; price?: number; id?: string }) => {
        modifierRows.push({
          order_item_id: orderItemId,
          modifier_group_name: m.groupName,
          modifier_option_name: m.optionName,
          price: m.price,
        });
      });
    });

    if (variantRows.length > 0) {
      const { error: vErr } = await supabase.from('order_item_variants').insert(variantRows);
      if (vErr) throw vErr;
    }
    if (modifierRows.length > 0) {
      const { error: mErr } = await supabase.from('order_item_modifiers').insert(modifierRows);
      if (mErr) throw mErr;
    }

    // 5. Payment(s) — supports single or split
    const paymentRows = paymentLegs.map((leg: PaymentLegInput) => ({
      order_id:        order.id,
      business_id:     req.businessId,
      branch_id,
      method:          leg.method,
      amount:          leg.amount,
      amount_tendered: leg.amount_tendered ?? leg.amount,
      change_given:    leg.change_given ?? 0,
      reference:       leg.reference ?? null,
      status:          'completed',
      sync_status:     'pending',
    }));

    const { error: pErr } = await supabase.from('payments').insert(paymentRows);
    if (pErr) throw pErr;

    // 6. Stock deduction
    // 6a. Product-level stock (for minimart / retail products with track_stock=true)
    //     Handles both sold_by='each' (unit deduction) and sold_by='piece' (piece deduction)
    const productIds = items.map((i: OrderItemInput) => i.product?.id).filter((id): id is string => !!id);
    const { data: trackedProducts } = await supabase
      .from('products')
      .select('id, track_stock, sold_by')
      .in('id', productIds)
      .eq('track_stock', true);

    const trackedMap = new Map((trackedProducts ?? [] as { id: string; track_inventory: boolean }[]).map(p => [p.id, p]));

    for (const item of items) {
      if (!item.product?.id) continue; // skip non-catalogue items (custom/fuel/parking)
      const prod = trackedMap.get(item.product.id);
      if (!prod) continue;

      if (prod.sold_by === 'piece') {
        // ── Piece-level deduction ─────────────────────────────────────────────
        // Each unit sold deducts 1 from qty_pieces. Never block the sale.
        const { data: stock } = await supabase
          .from('stock_levels')
          .select('qty_pieces')
          .eq('product_id', item.product.id)
          .eq('branch_id', branch_id)
          .single();

        const currentPieces = stock?.qty_pieces ?? 0;
        const newPieces = Math.max(0, currentPieces - item.quantity);

        await supabase
          .from('stock_levels')
          .upsert(
            { product_id: item.product.id, branch_id, qty_pieces: newPieces, updated_at: new Date().toISOString() },
            { onConflict: 'product_id,branch_id' }
          );

        await supabase
          .from('stock_movements')
          .insert({
            product_id: item.product.id,
            branch_id,
            movement_type: 'sale',
            quantity_change: -item.quantity,
            quantity_after: newPieces,
            notes: `Order ${order_number} (pieces)`,
          });
      } else {
        // ── Unit-level deduction (each / weight / volume) ─────────────────────
        const { data: stock } = await supabase
          .from('stock_levels')
          .select('quantity')
          .eq('product_id', item.product.id)
          .eq('branch_id', branch_id)
          .single();

        const currentQty = stock?.quantity ?? 0;
        const newQty = Math.max(0, currentQty - item.quantity);

        await supabase
          .from('stock_levels')
          .upsert(
            { product_id: item.product.id, branch_id, quantity: newQty, updated_at: new Date().toISOString() },
            { onConflict: 'product_id,branch_id' }
          );

        await supabase
          .from('stock_movements')
          .insert({
            product_id: item.product.id,
            branch_id,
            movement_type: 'sale',
            quantity_change: -item.quantity,
            quantity_after: newQty,
            notes: `Order ${order_number}`,
          });
      }
    }

    // 6a-bis. Fuel wet-stock deduction.
    // Deducts litres from the correct tank using the following priority:
    //   1. pump_id on the order → pump.tank_id → deduct from that specific tank
    //      (exact when a station has multiple tanks of the same grade)
    //   2. Fallback: match tanks by fuel_product_id (original behaviour — works
    //      when only one tank per grade, i.e. most single-site stations)
    try {
      const litresByProduct: Record<string, number> = {};
      for (const item of items) {
        const pid = item.product?.id;
        if (pid) litresByProduct[pid] = (litresByProduct[pid] ?? 0) + Number(item.quantity);
      }
      const fuelProductIds = Object.keys(litresByProduct);
      if (fuelProductIds.length > 0) {
        // Strategy 1: if the order has a pump_id, check if that pump has a tank_id
        let specificTankId: string | null = null;
        if (order.pump_id) {
          const { data: pump } = await supabase
            .from('pumps')
            .select('tank_id, fuel_product_id')
            .eq('id', order.pump_id)
            .eq('business_id', req.businessId)
            .single();
          if (pump?.tank_id) {
            specificTankId = pump.tank_id;
          }
        }

        let tanksToDeduct: Array<{ id: string; fuel_product_id: string; current_level: string }> = [];

        if (specificTankId) {
          // Exact match — deduct from the pump's assigned tank only
          const { data: specificTank } = await supabase
            .from('fuel_tanks')
            .select('id, fuel_product_id, current_level')
            .eq('id', specificTankId)
            .eq('business_id', req.businessId)
            .single();
          if (specificTank) tanksToDeduct = [specificTank];
        } else {
          // Fallback — match by fuel_product_id (works for single-tank-per-grade)
          let tankQuery = supabase
            .from('fuel_tanks')
            .select('id, fuel_product_id, current_level')
            .eq('business_id', req.businessId)
            .in('fuel_product_id', fuelProductIds);
          if (branch_id && /^[0-9a-fA-F-]{36}$/.test(branch_id)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tankQuery = (tankQuery as any).or(`branch_id.eq.${branch_id},branch_id.is.null`);
          }
          const { data: tanks } = await tankQuery;
          tanksToDeduct = tanks ?? [];
        }

        for (const tank of tanksToDeduct) {
          const litres = litresByProduct[tank.fuel_product_id] ?? 0;
          if (litres > 0) {
            const newLevel = Math.max(0, Number(tank.current_level) - litres);
            await supabase.from('fuel_tanks').update({ current_level: newLevel }).eq('id', tank.id);
            supabase.from('stock_movements').insert({
              business_id:     req.businessId,
              product_id:      tank.fuel_product_id,
              branch_id:       branch_id ?? null,
              movement_type:   'sale',
              quantity_change: -litres,
              quantity_after:   newLevel,
              notes:           `Fuel sale — order ${order_number}`,
              reference_type:  'order',
              reference_id:    order.id,
              created_by:      req.userId ?? null,
            }).then(() => {}).catch(e => console.error('[fuel-sale] movement log failed:', e));
          }
        }
      }
    } catch (err) {
      console.error('[orders] fuel tank deduction failed (non-blocking):', err);
    }

    // 6b. Ingredient deduction via recipes
    // For each item sold, look up its recipe and deduct ingredient quantities.
    // This is best-effort — we never block a sale due to stock issues.
    try {
      // Fetch all recipes for the products in this order in one query
      const { data: recipeRows } = await supabase
        .from('recipes')
        .select('product_id, ingredient_id, quantity_per_serving')
        .eq('business_id', req.businessId)
        .in('product_id', productIds);

      if (recipeRows && recipeRows.length > 0) {
        // Aggregate total deduction per ingredient across all items in the order
        const deductions: Record<string, number> = {};

        for (const item of items) {
          const recipe = recipeRows.filter((r: { product_id: string; ingredient_id: string; quantity_per_serving: string }) => item.product?.id && r.product_id === item.product.id);
          for (const line of recipe) {
            const totalQty = line.quantity_per_serving * item.quantity;
            deductions[line.ingredient_id] = (deductions[line.ingredient_id] ?? 0) + totalQty;
          }
        }

        // Apply deductions per-branch via the atomic RPC (concurrency-safe:
        // the read+write happen in one statement, so simultaneous sales of the
        // same item can't clobber each other's stock).
        const ingredientIds = Object.keys(deductions);
        if (ingredientIds.length > 0) {
          for (const [ingredientId, deductQty] of Object.entries(deductions)) {
            const { data: newQty, error: decErr } = await supabase.rpc('adjust_ingredient_stock', {
              p_ingredient_id: ingredientId,
              p_branch_id:     branch_id,
              p_business_id:   req.businessId,
              p_delta:         -deductQty, // negative = deduct; allowed to go negative (never block a sale)
            });
            if (decErr) { console.error('Ingredient deduction error (non-fatal):', decErr.message); continue; }

            await supabase
              .from('ingredient_stock_movements')
              .insert({
                business_id:     req.businessId,
                ingredient_id:   ingredientId,
                branch_id,
                movement_type:   'sale',
                quantity_change: -deductQty,
                quantity_after:  newQty,
                notes:           `Order ${order_number}`,
                created_by:      req.userId,
              });
          }

          // Fire low-ingredient alerts (non-blocking)
          checkLowIngredients(req.businessId, branch_id, ingredientIds).catch(() => {});
        }
      }
    } catch (recipeErr) {
      // Never let recipe deduction fail an order
      console.error('Recipe deduction error (non-fatal):', recipeErr?.message);
    }

    // 7. Kitchen ticket
    const { error: ktErr } = await supabase
      .from('kitchen_tickets')
      .insert({ order_id: order.id, branch_id, status: 'new' });
    if (ktErr) console.error('Failed to create kitchen ticket:', ktErr.message);

    // 7b. Trigger low-stock check for products sold (non-blocking)
    const trackedProductIds = items
      .filter((i: OrderItemInput) => trackedMap.has(i.product?.id ?? ''))
      .map((i: OrderItemInput) => i.product?.id ?? '');
    checkLowStock(req.businessId, branch_id, trackedProductIds).catch(() => {});

    // 8. Loyalty — deduct redeemed points, then award earned points
    if (customer_id) {
      // 8a. Deduct redeemed points
      if (points_redeemed > 0) {
        const { data: customer } = await supabase
          .from('customers')
          .select('loyalty_points')
          .eq('id', customer_id)
          .single();

        await supabase
          .from('customers')
          .update({ loyalty_points: Math.max(0, (customer?.loyalty_points ?? 0) - points_redeemed) })
          .eq('id', customer_id)
          .eq('business_id', req.businessId);

        await supabase
          .from('loyalty_transactions')
          .insert({
            customer_id,
            business_id: req.businessId,
            order_id: order.id,
            type: 'redeem',
            points: -points_redeemed,
            notes: `Redeemed on order ${order_number}`,
          });
      }

      // 8b. Earn points on net total (after discount), using tier multiplier
      const earnRate = await getLoyaltyEarnRate(req.businessId);
      const { data: customerForTier } = await supabase
        .from('customers')
        .select('loyalty_points')
        .eq('id', customer_id)
        .single();

      const currentPoints = customerForTier?.loyalty_points ?? 0;
      const { multiplier } = getTier(currentPoints);
      const netTotal = authTotal; // total already has discount applied
      const basePoints = Math.floor(netTotal / 10) * earnRate;
      const pointsToEarn = Math.floor(basePoints * multiplier);

      if (pointsToEarn > 0) {
        await awardLoyaltyPoints(customer_id, req.businessId, order.id, pointsToEarn, order_number);
      }

      // 8c. Update total_spent on customer (inline — no RPC dependency)
      const { data: cSpent } = await supabase
        .from('customers')
        .select('total_spent')
        .eq('id', customer_id)
        .single();
      await supabase
        .from('customers')
        .update({ total_spent: (cSpent?.total_spent ?? 0) + authTotal })
        .eq('id', customer_id)
        .eq('business_id', req.businessId);
    }

    // 9. Increment discount usage count if a promo was applied
    if (discount_id) {
      await supabase.rpc('increment_discount_usage', { discount_uuid: discount_id });
    }

    // 10. Fire webhook — non-blocking
    fireWebhook(req.businessId, 'order.completed', {
      order_id: order.id, order_number: order.order_number,
      order_type, total: authTotal, branch_id, cashier_id: req.userId,
    }).catch(() => {});

    // Credit sale: post the charge to the customer's account ledger. Limit was
    // already checked above; enforce again in the RPC as a concurrency guard.
    if (creditLeg && customer_id) {
      const { error: credErr } = await supabase.rpc('apply_credit_transaction', {
        p_business_id:   req.businessId,
        p_customer_id:   customer_id,
        p_branch_id:     branch_id,
        p_order_id:      order.id,
        p_type:          'charge',
        p_amount:        Math.abs(Number(creditLeg.amount) || 0),
        p_method:        null,
        p_reference:     null,
        p_notes:         null,
        p_created_by:    req.userId,
        p_enforce_limit: true,
      });
      if (credErr) console.error('[credit] charge failed for order', order.id, credErr.message);
    }

    // 11. Fiscalise with KRA eTIMS — non-blocking; never fails the sale.
    fiscaliseInvoice(order.id).catch((e) => console.error('[etims] fiscaliseInvoice:', e?.message));

    res.status(201).json({ orderId: order.id, orderNumber: order.order_number });
  } catch (err) {
    sendError(res, err, { message: 'Failed to create order' });
  }
});

// GET /api/orders
router.get('/', async (req, res) => {
  const { status, date_from, date_to, search, limit = '50', offset = '0' } = req.query;

  // Owner: may filter by any branch_id or get all. Staff: locked to their branch.
  const scopedBranch = branchScope(req);

  let query = supabase
    .from('orders')
    .select(`
      id, order_number, order_type, status, subtotal, vat_amount, discount_amount,
      loyalty_points_used, total, created_at, branch_id, customer_name,
      payments ( method, amount, status )
    `, { count: 'exact' })
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false })
    .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

  if (scopedBranch) query = query.eq('branch_id', scopedBranch);
  if (status)       query = query.eq('status', status as string);
  if (date_from)    query = query.gte('created_at', date_from as string);
  if (date_to)      query = query.lte('created_at', date_to as string);
  if (search)       query = query.ilike('order_number', `%${search}%`);

  const { data, error, count } = await query;
  if (error) { sendError(res, error); return; }
  res.json({ orders: data ?? [], total: count ?? 0 });
});

// GET /api/orders/:id
router.get('/:id', async (req, res, next) => {
  // Literal sibling routes (e.g. GET /turnover) are registered after this one.
  // Order ids are UUIDs, so for any non-UUID id defer to the next matching route
  // instead of treating it as an order lookup (which would 404).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    next();
    return;
  }
  let query = supabase
    .from('orders')
    .select(`
      *,
      order_items (
        *,
        order_item_variants ( * ),
        order_item_modifiers ( * )
      ),
      payments ( * )
    `)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  // Non-owners can only fetch orders from their branch
  const scopedBranch = branchScope(req);
  if (scopedBranch) query = query.eq('branch_id', scopedBranch);

  const { data, error } = await query.single();
  if (error) { res.status(404).json({ error: 'Order not found' }); return; }

  // For voided orders, resolve the cashier who voided and the supervisor who
  // authorized it (if any) to names, so the order detail can show attribution.
  if ((data as any).status === 'voided') {
    const ids = [ (data as any).voided_by, (data as any).authorized_by ].filter(Boolean) as string[];
    if (ids.length) {
      const { data: users } = await supabase
        .from('users').select('id, name').in('id', [...new Set(ids)]);
      const nameMap: Record<string, string> = {};
      (users ?? []).forEach((u: any) => { nameMap[u.id] = u.name; });
      (data as any).voided_by_name     = (data as any).voided_by     ? (nameMap[(data as any).voided_by]     ?? null) : null;
      (data as any).authorized_by_name = (data as any).authorized_by ? (nameMap[(data as any).authorized_by] ?? null) : null;
    }
  }

  res.json(data);
});

// POST /api/orders/:id/void
const VOID_WINDOW_MINUTES = 30;

router.post('/:id/void', requirePermission('orders.void'), async (req, res) => {
  const { reason, supervisor_pin, override_pin, authorizer_id } = req.body;
  const orderId = req.params.id;

  if (!reason) {
    res.status(400).json({ error: 'A reason is required to void an order' });
    return;
  }

  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select(`
      *,
      order_items ( product_id, quantity ),
      payments ( id, status, amount, method )
    `)
    .eq('id', orderId)
    .eq('business_id', req.businessId)
    .single();

  if (oErr || !order) { res.status(404).json({ error: 'Order not found' }); return; }
  if (order.status === 'voided') { res.status(400).json({ error: 'Order is already voided' }); return; }

  const orderAge = (Date.now() - new Date(order.created_at).getTime()) / 60000;
  if (orderAge > VOID_WINDOW_MINUTES) {
    res.status(403).json({
      error: `Orders can only be voided within ${VOID_WINDOW_MINUTES} minutes of creation`,
      code: 'VOID_WINDOW_EXPIRED',
    });
    return;
  }

  const completedPayment = (order.payments ?? []).find((p: { id: string; status: string; amount: string; method: string }) => p.status === 'completed');
  let authorizedBy: string | null = null;
  if (completedPayment) {
    const pin = (override_pin ?? supervisor_pin) as string | undefined;
    const ov = await verifyOverrideAuthorizer(req.businessId, authorizer_id, pin);

    if (ov.result === 'ok') {
      authorizedBy = ov.userId ?? null;
    } else if (ov.result === 'no_authorizers') {
      // Transition fallback: no per-user override PINs configured yet — accept
      // the legacy business-wide supervisor PIN so existing installs keep working.
      const legacy = await verifySupervisorPin(req.businessId, pin);
      if (legacy === 'not_configured') {
        res.status(400).json({
          error: 'No override PIN configured. Set one for a supervisor in Staff Management → Staff Members.',
          code:  'NO_OVERRIDE_CONFIGURED',
        });
        return;
      }
      if (!legacy) {
        res.status(403).json({ error: 'Invalid supervisor PIN' });
        return;
      }
      // legacy PIN valid — authorizedBy stays null (no identifiable supervisor)
    } else {
      res.status(403).json({ error: 'Invalid override PIN, or the selected supervisor is not authorized' });
      return;
    }
  }

  try {
    // 1. Mark order voided
    const { error: vErr } = await supabase
      .from('orders')
      .update({ status: 'voided', void_reason: reason, voided_at: new Date().toISOString(), voided_by: req.userId, authorized_by: authorizedBy })
      .eq('id', orderId);
    if (vErr) throw vErr;

    // 2. Refund payment record
    if (completedPayment) {
      const { error: rErr } = await supabase
        .from('payments')
        .insert({
          order_id: orderId,
          business_id: req.businessId,
          branch_id: order.branch_id,
          method: completedPayment.method,
          amount: -completedPayment.amount,
          amount_tendered: 0,
          change_given: 0,
          reference: `VOID-${order.order_number}`,
          status: 'refunded',
          sync_status: 'pending',
        });
      if (rErr) throw rErr;
    }

    // 3. Reverse stock
    const productIds = (order.order_items ?? [] as { product_id: string | null; quantity: string }[]).map(i => i.product_id).filter((id): id is string => !!id);
    const { data: trackedProducts } = await supabase
      .from('products')
      .select('id, track_stock')
      .in('id', productIds)
      .eq('track_stock', true);

    const trackedIds = new Set((trackedProducts ?? [] as { id: string }[]).map(p => p.id));

    for (const item of order.order_items ?? []) {
      if (!trackedIds.has(item.product_id)) continue;

      const { data: stock } = await supabase
        .from('stock_levels')
        .select('quantity')
        .eq('product_id', item.product_id)
        .eq('branch_id', order.branch_id)
        .single();

      const currentQty = stock?.quantity ?? 0;
      const newQty = currentQty + item.quantity;

      await supabase
        .from('stock_levels')
        .upsert(
          { product_id: item.product_id, branch_id: order.branch_id, quantity: newQty, updated_at: new Date().toISOString() },
          { onConflict: 'product_id,branch_id' }
        );

      await supabase
        .from('stock_movements')
        .insert({
          product_id: item.product_id,
          branch_id: order.branch_id,
          movement_type: 'correction',
          quantity_change: item.quantity,
          quantity_after: newQty,
          notes: `Void of Order ${order.order_number}: ${reason}`,
          cashier_id: req.userId,
        });
    }

    // 4. Reverse loyalty if order had a customer
    if (order.customer_id) {
      const { data: loyaltyTxns } = await supabase
        .from('loyalty_transactions')
        .select('type, points')
        .eq('order_id', orderId)
        .eq('customer_id', order.customer_id);

      const { data: customer } = await supabase
        .from('customers')
        .select('loyalty_points, total_spent, visit_count')
        .eq('id', order.customer_id)
        .single();

      if (customer && loyaltyTxns) {
        let pointsDelta = 0;
        for (const txn of loyaltyTxns) {
          // earn txns: reverse (subtract); redeem txns (negative points): reverse (add back)
          pointsDelta -= txn.points;
        }

        const newPoints = Math.max(0, (customer.loyalty_points ?? 0) + pointsDelta);
        const newSpent = Math.max(0, (customer.total_spent ?? 0) - order.total);
        const newVisits = Math.max(0, (customer.visit_count ?? 0) - 1);

        await supabase
          .from('customers')
          .update({ loyalty_points: newPoints, total_spent: newSpent, visit_count: newVisits })
          .eq('id', order.customer_id);

        await supabase
          .from('loyalty_transactions')
          .insert({
            customer_id: order.customer_id,
            business_id: req.businessId,
            order_id: orderId,
            type: 'adjust',
            points: pointsDelta,
            notes: `Void of order ${order.order_number}: ${reason}`,
          });
      }
    }

    // Fire webhook — non-blocking
    fireWebhook(req.businessId, 'order.voided', {
      order_id: orderId, order_number: order.order_number,
      total: order.total, branch_id: order.branch_id,
      void_reason: reason, voided_by: req.userId,
    }).catch(() => {});

    // eTIMS credit note for the voided sale — non-blocking.
    fiscaliseCreditNote(orderId).catch((e) => console.error('[etims] fiscaliseCreditNote:', e?.message));

    res.json({ success: true, orderId });
  } catch (err) {
    sendError(res, err, { message: 'Failed to void order' });
  }
});

// ── POST /api/orders/open ──────────────────────────────────────────────────────
// Order-first restaurant model: creates an open order + kitchen ticket with no
// payment. The order stays open until POST /api/orders/:id/pay closes it.

router.post('/open', async (req, res) => {
  const {
    branch_id,
    order_number,
    order_type = 'dine_in',
    table_number,
    covers = 1,
    subtotal,
    vat_amount,
    total,
    items,
    customer_id = null,
    customer_name = null,
    shift_id = null,
  } = req.body;

  if (!branch_id || !order_number || !items?.length) {
    res.status(400).json({ error: 'branch_id, order_number and items are required' });
    return;
  }

  // Item 5: branch access guard
  if (!assertBranchAccess(req, branch_id)) {
    res.status(403).json({ error: 'You do not have access to this branch' });
    return;
  }

  try {
    // Item 7: customer must belong to this business
    if (customer_id) {
      const { data: cust } = await supabase
        .from('customers').select('id').eq('id', customer_id).eq('business_id', req.businessId).maybeSingle();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
    }

    // Item 4: authoritative totals (no discount applied at open time)
    const recomputed = await recomputeOrderTotals(req.businessId, branch_id, items, 0);
    if (!recomputed.ok) { res.status(recomputed.status).json({ error: recomputed.error }); return; }
    const { lines: authLines, subtotal: authSubtotal, total: authTotal, vat: authVat } = recomputed;

    // 1. Create the order in 'open' status — no payment yet
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .insert({
        business_id:     req.businessId,
        branch_id,
        order_number,
        order_type,
        table_number,
        covers,
        subtotal:        authSubtotal,
        vat_amount:      authVat,
        total:           authTotal,
        discount_amount: 0,
        status:          'open',
        cashier_id:      req.userId,
        customer_id,
        customer_name,
        shift_id,
        seated_at:       order_type === 'dine_in' ? new Date().toISOString() : null,
        sync_status:     'pending',
      })
      .select()
      .single();

    if (oErr || !order) {
      sendError(res, oErr, { message: 'Failed to create order' });
      return;
    }

    // 2. Insert order items
    const orderItems = items.map((item: OrderItemInput, idx: number) => ({
      order_id:      order.id,
      product_id:    item.product?.id ?? null,
      product_name:  item.product.name,
      category_name: Array.isArray(item.product.categories)
        ? item.product.categories[0]?.name
        : item.product.categories?.name ?? null,
      unit_price: authLines[idx].unitPrice,
      quantity:   item.quantity,
      subtotal:   authLines[idx].lineTotal,
      notes:      item.notes ?? null,
      course:      item.course ?? null,
      fire_status: item.fire_status === 'held' ? 'held' : 'fired',
    }));

    const { data: insertedItems, error: itemErr } = await supabase
      .from('order_items')
      .insert(orderItems)
      .select();

    if (itemErr) {
      sendError(res, itemErr);
      return;
    }

    // 3. Create kitchen ticket immediately — kitchen starts cooking now
    const { error: ktErr } = await supabase
      .from('kitchen_tickets')
      .insert({ order_id: order.id, branch_id, status: 'new' });

    if (ktErr) console.error('Failed to create kitchen ticket:', ktErr.message);

    res.status(201).json({ orderId: order.id, orderNumber: order.order_number });
  } catch (err) {
    sendError(res, err, { message: 'Failed to open order' });
  }
});

// ── POST /api/orders/:id/pay ───────────────────────────────────────────────────
// Order-first model: attaches payment to an existing open order, deducts stock,
// awards loyalty, and marks the order completed.

router.post('/:id/pay', async (req, res) => {
  const orderId = req.params.id;
  const {
    payments,
    payment,
    customer_id,
    points_redeemed = 0,
    discount_amount = 0,
    discount_id = null,
  } = req.body;

  const paymentLegs: PaymentLegInput[] = Array.isArray(payments) && payments.length > 0
    ? payments
    : payment ? [payment] : [];

  if (!paymentLegs.length) {
    res.status(400).json({ error: 'At least one payment leg is required' });
    return;
  }

  try {
    // 1. Load the open order
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select('*, order_items ( product_id, quantity, subtotal, product_name, category_name, unit_price, notes )')
      .eq('id', orderId)
      .eq('business_id', req.businessId)
      .single();

    if (oErr || !order) { res.status(404).json({ error: 'Order not found' }); return; }
    if (order.status !== 'open') {
      res.status(400).json({ error: `Order is already ${order.status}` });
      return;
    }

    // ── L5: a client-supplied discount_id must belong to this business ───────
    if (discount_id) {
      const { data: disc } = await supabase
        .from('discounts')
        .select('id')
        .eq('id', discount_id)
        .eq('business_id', req.businessId)
        .maybeSingle();
      if (!disc) { res.status(400).json({ error: 'Invalid discount' }); return; }
    }

    // 2. Insert payment legs
    const paymentRows = paymentLegs.map((leg: PaymentLegInput) => ({
      order_id:        order.id,
      business_id:     req.businessId,
      branch_id:       order.branch_id,
      method:          leg.method,
      amount:          leg.amount,
      amount_tendered: leg.amount_tendered ?? null,
      change_given:    leg.change_given ?? null,
      reference:       leg.reference ?? null,
      status:          'completed',
      sync_status:     'pending',
      mpesa_checkout_id: leg.mpesa_checkout_id ?? null,
    }));

    const { error: pErr } = await supabase.from('payments').insert(paymentRows);
    if (pErr) { sendError(res, pErr); return; }

    // 3. Mark order completed
    const { error: uErr } = await supabase
      .from('orders')
      .update({
        status:          'completed',
        discount_amount: discount_amount ?? 0,
        discount_id,
        sync_status:     'pending',
      })
      .eq('id', order.id);

    if (uErr) { sendError(res, uErr); return; }

    // 4. Deduct stock for each item
    for (const item of order.order_items ?? []) {
      if (!item.product_id) continue;
      const { data: sl } = await supabase
        .from('stock_levels')
        .select('id, quantity')
        .eq('product_id', item.product_id)
        .eq('branch_id', order.branch_id)
        .single();

      if (sl) {
        await supabase
          .from('stock_levels')
          .update({ quantity: Math.max(0, sl.quantity - item.quantity) })
          .eq('id', sl.id);
      }
    }

    // 5. Loyalty
    if (customer_id) {
      if (points_redeemed > 0) {
        await supabase
          .from('customers')
          .update({ loyalty_points: supabase.rpc('decrement', { x: points_redeemed }) })
          .eq('id', customer_id);
      }
      const pointsEarned = Math.floor(order.total / 100);
      if (pointsEarned > 0) {
        await supabase.rpc('increment_loyalty_points', {
          p_customer_id: customer_id,
          p_points:      pointsEarned,
        });
      }
    }

    // 6. Increment discount usage
    if (discount_id) {
      await supabase.rpc('increment_discount_usage', { discount_uuid: discount_id });
    }

    // 7. Fire webhook — non-blocking
    fireWebhook(req.businessId, 'order.completed', {
      order_id: order.id, order_number: order.order_number,
      order_type: order.order_type, total: order.total,
      branch_id: order.branch_id, cashier_id: req.userId,
    }).catch(() => {});

    // 8. Fiscalise with KRA eTIMS — non-blocking; never fails the sale.
    fiscaliseInvoice(order.id).catch((e) => console.error('[etims] fiscaliseInvoice:', e?.message));

    res.json({ orderId: order.id, orderNumber: order.order_number });
  } catch (err) {
    sendError(res, err, { message: 'Failed to process payment' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Restaurant dine-in: course firing, split bill, turnover (items 11–13)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/orders/:id/fire-course
// Body: { course } — fires all 'held' items of that course to the kitchen.
// Marks them fired and (re)issues a kitchen ticket so the line sees them.
router.post('/:id/fire-course', async (req, res) => {
  const { id } = req.params;
  const { course } = req.body;
  if (!course) { res.status(400).json({ error: 'course is required' }); return; }

  // Order must belong to this business.
  const { data: order } = await supabase
    .from('orders').select('id, branch_id').eq('id', id).eq('business_id', req.businessId).single();
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

  const { data: fired, error } = await supabase
    .from('order_items')
    .update({ fire_status: 'fired', fired_at: new Date().toISOString() })
    .eq('order_id', id).eq('course', course).eq('fire_status', 'held')
    .select('id');
  if (error) { sendError(res, error); return; }

  // New kitchen ticket for the fired course so the KDS/printer picks it up.
  if ((fired?.length ?? 0) > 0) {
    await supabase.from('kitchen_tickets').insert({
      order_id: id, branch_id: order.branch_id, station: course, status: 'new',
    });
  }

  res.json({ fired: fired?.length ?? 0 });
});

// PATCH /api/orders/:id/split
// Body: { assignments: [{ order_item_id, sub_bill }] } — assigns items to
// numbered sub-bills (by-item split). sub_bill null clears the assignment.
router.patch('/:id/split', async (req, res) => {
  const { id } = req.params;
  const { assignments } = req.body;
  if (!Array.isArray(assignments)) { res.status(400).json({ error: 'assignments array required' }); return; }

  const { data: order } = await supabase
    .from('orders').select('id').eq('id', id).eq('business_id', req.businessId).single();
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

  // Only touch items that belong to this order.
  const { data: ownItems } = await supabase
    .from('order_items').select('id').eq('order_id', id);
  const ownSet = new Set((ownItems ?? [] as { id: string }[]).map(i => i.id));

  for (const a of assignments) {
    if (!ownSet.has(a.order_item_id)) continue;
    await supabase.from('order_items')
      .update({ sub_bill: a.sub_bill ?? null })
      .eq('id', a.order_item_id).eq('order_id', id);
  }
  res.json({ ok: true });
});

// GET /api/orders/turnover?branch_id=  — live dwell time for open dine-in orders.
// Returns each open dine-in order with minutes seated and an `over` flag against
// the business's turnover_alert_minutes setting.
router.get('/turnover', async (req, res) => {
  const branchId = (req.query.branch_id as string) || branchScope(req);
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { data: setting } = await supabase
    .from('business_settings').select('value')
    .eq('business_id', req.businessId).eq('key', 'turnover_alert_minutes').maybeSingle();
  let threshold = 90;
  if (setting?.value !== undefined) {
    const v = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
    threshold = Number(v) || 90;
  }

  const { data: orders } = await supabase
    .from('orders')
    .select('id, table_number, covers, seated_at, total')
    .eq('business_id', req.businessId).eq('branch_id', branchId)
    .eq('order_type', 'dine_in').eq('status', 'open');

  const now = Date.now();
  const rows = (orders ?? [] as Array<{ id: string; table_number: string | null; covers: number | null; seated_at: string | null; completed_at: string | null; total: string }>).map(o => {
    const seated = o.seated_at ? new Date(o.seated_at).getTime() : now;
    const minutes = Math.floor((now - seated) / 60000);
    return {
      order_id: o.id, table_number: o.table_number, covers: o.covers,
      seated_at: o.seated_at, minutes_seated: minutes, over: minutes >= threshold,
    };
  }).sort((a, b) => b.minutes_seated - a.minutes_seated);

  res.json({ threshold_minutes: threshold, tables: rows });
});

// GET /api/orders/turnover/report?branch_id=&from=&to=  — avg dwell per table.
router.get('/turnover/report', requirePermission('reports.view'), async (req, res) => {
  const branchId = (req.query.branch_id as string) || branchScope(req);
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'Forbidden' }); return; }

  let q = supabase
    .from('orders')
    .select('table_number, seated_at, updated_at')
    .eq('business_id', req.businessId).eq('branch_id', branchId)
    .eq('order_type', 'dine_in').eq('status', 'completed')
    .not('seated_at', 'is', null);
  if (req.query.from) q = q.gte('created_at', req.query.from as string);
  if (req.query.to)   q = q.lte('created_at', req.query.to as string);

  const { data, error } = await q;
  if (error) { sendError(res, error); return; }

  // Aggregate avg dwell minutes per table.
  const agg: Record<string, { total: number; count: number }> = {};
  (data ?? [] as Array<{ table_number: string | null; total: string; covers: number | null; seated_at: string | null; completed_at: string | null }>).forEach(o => {
    if (!o.table_number || !o.seated_at || !o.updated_at) return;
    const mins = (new Date(o.updated_at).getTime() - new Date(o.seated_at).getTime()) / 60000;
    if (mins < 0) return;
    const key = o.table_number;
    (agg[key] ??= { total: 0, count: 0 });
    agg[key].total += mins; agg[key].count += 1;
  });

  const rows = Object.entries(agg).map(([table, v]) => ({
    table_number: table, covers_served: v.count,
    avg_minutes: Math.round(v.total / v.count),
  })).sort((a, b) => b.avg_minutes - a.avg_minutes);

  res.json({ tables: rows });
});

// POST /api/orders/:id/whatsapp-receipt
// Body: { phone? } — sends the receipt to the customer's WhatsApp. Uses the
// order's customer_phone if no phone is supplied. Non-blocking-safe (logs the
// attempt; returns the delivery status).
router.post('/:id/whatsapp-receipt', async (req, res) => {
  const { id } = req.params;
  const { data: order } = await supabase
    .from('orders')
    .select('id, business_id, order_number, total, tip_amount, customer_phone, customer_name')
    .eq('id', id).eq('business_id', req.businessId).single();
  if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

  const phone = (req.body?.phone as string) || order.customer_phone;
  if (!phone) { res.status(400).json({ error: 'No phone number for this customer' }); return; }

  const { data: biz } = await supabase
    .from('businesses').select('name, currency').eq('id', req.businessId).single();
  const currency = biz?.currency ?? 'KES';
  const grand = Number(order.total) + Number(order.tip_amount ?? 0);
  const totalStr = `${currency} ${grand.toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
  const receiptText =
    `${biz?.name ?? 'Receipt'}\nOrder ${order.order_number}\nTotal: ${totalStr}` +
    (Number(order.tip_amount) > 0 ? `\n(incl. tip ${currency} ${Number(order.tip_amount).toFixed(2)})` : '') +
    `\nThank you!`;

  await sendReceiptWhatsApp(supabase, {
    businessId: req.businessId, orderId: id, toPhone: phone,
    businessName: biz?.name ?? 'SwiftPOS', total: totalStr, receiptText,
  });

  // Return the latest delivery row's status.
  const { data: log } = await supabase
    .from('whatsapp_deliveries').select('status, error')
    .eq('order_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  res.json({ status: log?.status ?? 'unknown', error: log?.error ?? null });
});

export default router;
