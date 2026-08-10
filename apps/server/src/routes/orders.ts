import { Router } from 'express';
import { classifyOrderCreateError } from '../lib/orderErrors';
import { sendError } from '../lib/sendError';
import { capDiscount } from '../lib/discountPolicy';
import { safeRouter } from '../middleware/asyncHandler';
import type { DbProduct, DbVariantGroup, DbModifierGroup, OrderItemInput, PaymentLegInput, DbOrder, DbPayment, DbCustomer } from '../lib/dbTypes';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { fireWebhook } from '../lib/webhooks';
import { requireAuth } from '../middleware/auth';
import { branchScope, requirePermission, assertBranchAccess } from '../middleware/rbac';
import { supabase } from '../lib/supabase';
import { terminalKey, terminalKeyFromRequest, deviceIdFromRequest } from '../lib/terminalKey';
import { checkDeviceBranch } from '../lib/deviceBinding';
import { getTier } from './loyalty';
import { checkLowStock, checkLowIngredients } from '../jobs/lowStockChecker';
import { applyStockEffects } from '../lib/stockEffects';
import { fiscaliseInvoice, fiscaliseCreditNote } from '../lib/etims';
import { sendReceiptWhatsApp } from '../lib/whatsapp';

const router = safeRouter();
router.use(requireAuth);

// Round to 2 dp (money) avoiding binary-float drift.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Payment integrity check (audit H1, detection only) ───────────────────────
//
// Nothing has ever verified that the payment legs on an order sum to the order
// total. A mismatch is money: the drawer and the books describe different sales,
// and it surfaces days later as an unexplained cash variance.
//
// This LOGS and does not reject. That is a deliberate choice for a pilot: an
// enforcement bug here refuses a real sale at the counter, mid-service, which is
// a worse failure than the one being prevented. Run detection for a week of live
// data first, confirm it is silent, then consider turning it into a 400.
//
// The log line is greppable: search the server log for [payment-mismatch].
function checkPaymentIntegrity(
  orderNumber: string,
  orderId: string,
  total: number,
  legs: Array<{ method?: string; amount?: unknown }>,
): void {
  const paid = legs.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const diff = Math.round((paid - total) * 100) / 100;
  if (Math.abs(diff) < 0.01) return;

  console.error(
    `[payment-mismatch] order ${orderNumber} (${orderId}): legs sum to ${paid.toFixed(2)} `
    + `but total is ${total.toFixed(2)} — difference ${diff > 0 ? '+' : ''}${diff.toFixed(2)}. `
    + `Legs: ${legs.map(l => `${l.method ?? '?'} ${Number(l.amount) || 0}`).join(', ') || '(none)'}`,
  );
}

// ── Discount ceiling (pilot stopgap for finding M4) ──────────────────────────
// Manual discounts are ungated: no permission check, no reason code, no
// supervisor authorisation, and the only limit was the order subtotal — so a
// cashier could zero out any sale. That is the most common POS fraud vector.
//
// The ceiling itself now lives in lib/discountPolicy so pos/init can advertise
// it to the till, which clamps to the same number before it prints anything.
// Enforcement here is unchanged and remains authoritative.

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
type RecomputeOk   = { ok: true; lines: { unitPrice: number; lineTotal: number }[]; subtotal: number; discount: number; total: number; vat: number; ctl: number };
type RecomputeFail = { ok: false; status: number; error: string };
type RecomputeResult = RecomputeOk | RecomputeFail;

// tsconfig has strict:false, under which truthiness narrowing on a boolean
// discriminant is unreliable — `if (!r.ok)` did not narrow to RecomputeFail.
// An explicit type predicate narrows correctly regardless of strictness.
const recomputeFailed = (r: RecomputeResult): r is RecomputeFail => !r.ok;

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
  const discount = capDiscount(discountAmount, subtotal);
  const total = round2(subtotal - discount);

  const { vat, ctl } = await taxSplit(businessId, total);

  return { ok: true, lines, subtotal, discount, total, vat, ctl };
}

/**
 * Split a tax-INCLUSIVE total into its VAT and catering-levy components.
 *
 * Extracted so the two paths that write tax to an order cannot drift. It was
 * previously inline in recomputeOrderTotals only, which is precisely why
 * POST /:id/pay — the order-first (dine-in) path — never recomputed tax at all
 * and left VAT standing at the pre-discount figure (audit H2).
 *
 * Menu prices include BOTH taxes, so the net is backed out using the combined
 * rate and each tax is then charged on that net. VAT is on the net, not on
 * net-plus-CTL, matching how the levy is assessed (its base excludes VAT) and
 * how the incumbent system on site computes it:
 *
 *     750 / 1.18 = 635.59 net  ->  ctl 12.71, vat 101.69, total 750.00
 *
 * With ctlRate = 0 this collapses exactly to VAT-only behaviour, so businesses
 * outside the levy's scope are unaffected.
 */
async function taxSplit(businessId: string, total: number): Promise<{ vat: number; ctl: number }> {
  const { data: bizRow } = await supabase
    .from('businesses').select('vat_rate, ctl_rate').eq('id', businessId).single();
  const vatRate = Number(bizRow?.vat_rate ?? 16);
  const ctlRate = Number(bizRow?.ctl_rate ?? 0);

  const net = total / (1 + (vatRate + ctlRate) / 100);
  return {
    vat: round2(net * (vatRate / 100)),
    ctl: round2(net * (ctlRate / 100)),
  };
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
  // p_points, NOT p_delta. PostgREST resolves an RPC by its NAMED ARGUMENT SET,
  // so calling (p_customer_id, p_delta) matched no function at all and returned
  // PGRST202 every single time. The fallback below tests for 'function' in the
  // message, PGRST202 reads "Could not find the function ... in the schema
  // cache", so it matched — and every award silently took the racy
  // read-modify-write path this RPC exists to replace. The atomic path had
  // never once executed. Signature: migrations/53_increment_loyalty_points.sql.
  const { error } = await supabase.rpc('increment_loyalty_points', {
    p_customer_id: customerId,
    p_points:      pointsToEarn,
  });

  // Fallback for pre-migration environments only. Narrowed to PGRST202 (the
  // function genuinely is not there) so it can no longer swallow a real error
  // — a permissions failure or a bad argument used to land here and look like
  // a successful award.
  if (error && (error.code === 'PGRST202' || /Could not find the function/i.test(error.message ?? ''))) {
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
    // Rider name for a delivery. Free text — see migrations/35_delivery_person.sql.
    delivery_person,
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

  // Finding #16: the branch on this payload is the TILL's claim about itself
  // (it lives in the machine's local config and travels with it). A terminal
  // physically moved to another branch keeps booking to its old one until
  // someone notices. checkDeviceBranch validates the claim against the
  // server-side binding (migration 52). It fails OPEN for an unbound or unknown
  // device — existing tills bind on first sight and keep trading — and only
  // refuses a CHANGE, so a moved till is caught. Refusing leaves the order on
  // the till to re-push once the branch is corrected; nothing is lost.
  {
    // deviceIdFromRequest, not a raw header read: a duplicated header arrives
    // comma-joined and would never match a bound device. See terminalKey.ts.
    const deviceId = deviceIdFromRequest(req) || null;
    const binding = await checkDeviceBranch(req.businessId, deviceId, branch_id);
    if (!binding.ok) {
      res.status(409).json({ error: binding.error, code: binding.code });
      return;
    }
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
    if (recomputeFailed(recomputed)) { res.status(recomputed.status).json({ error: recomputed.error }); return; }
    const {
      lines: authLines,
      subtotal: authSubtotal,
      discount: authDiscount,
      total: authTotal,
      vat: authVat,
      ctl: authCtl,
    } = recomputed;

    // ── Finding #19: offline re-pricing divergence ──────────────────────────
    // The server ALWAYS re-prices against the current catalogue for anti-tampering
    // — correct for a live web sale. But an OFFLINE desktop order was already
    // priced against the catalogue at sale time, PRINTED, and PAID. If a price
    // changed between that sale and this sync, the re-priced total silently
    // diverges from the receipt the customer holds. We cannot blindly trust the
    // client (that defeats anti-tampering) nor blindly overwrite (that contradicts
    // the receipt), so we DETECT and log the divergence for reconciliation. The
    // stored total remains the authoritative re-priced figure — but now the
    // discrepancy is visible instead of silent, and can be reviewed.
    const clientTotal = Number(total);
    if (Number.isFinite(clientTotal) && Math.abs(clientTotal - authTotal) > 0.01) {
      const isOffline = !!(req.body?.created_at || req.body?.client_created_at);
      console.warn(
        `[reprice-divergence]${isOffline ? ' OFFLINE' : ''} order ${order_number}: ` +
        `client total ${clientTotal.toFixed(2)} vs re-priced ${authTotal.toFixed(2)} ` +
        `(diff ${(clientTotal - authTotal).toFixed(2)}). Stored the re-priced figure; ` +
        `review if this was an offline sale whose catalogue price changed before sync.`,
      );
    }

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
    // Attach the order to THIS TERMINAL's open drawer session, not the cashier's.
    // A shift is the terminal's session (see migration 63): whoever is on this
    // terminal sells into its drawer. Resolving by cashier_id (the old behaviour)
    // meant a cashier who had opened a drawer on another terminal pulled that
    // shift onto this sale, so the money and the sale landed on different drawers.
    // The client's supplied shift_id wins when present (it already reflects the
    // terminal's session from /shifts/current); otherwise resolve by terminal.
    let resolvedShiftId: string | null = shift_id ?? null;
    if (!resolvedShiftId) {
      const tkey = terminalKeyFromRequest(req);
      const { data: openShifts } = await supabase
        .from('shifts')
        .select('id, device_id, terminal_code, branch_id')
        .eq('business_id', req.businessId)
        .eq('status', 'open')
        .order('opened_at', { ascending: false });
      const match = (openShifts ?? []).find(
        s => terminalKey(s.device_id ?? '', s.terminal_code ?? '', s.branch_id ?? '') === tkey,
      );
      if (match) resolvedShiftId = (match as { id: string }).id;
    }

    // ── Atomic core write ──────────────────────────────────────────────────
    // Order + items + variants + modifiers + payments go in ONE transaction via
    // create_order_atomic (migration 62). Previously these were ~5 sequential
    // PostgREST inserts with no transaction: a failure after the order row but
    // before payments left a completed order with no tender. The RPC also
    // validates that the legs reconcile to the total (finding #15) and aborts if
    // they do not, rather than logging a mismatch after the fact.
    //
    // Stock, loyalty, discount counters and the KDS ticket stay BELOW as
    // post-commit effects — they are consequences of the sale, not part of its
    // identity, and they now run only after a durable, complete order exists, so
    // a failure in any of them can no longer orphan the order.
    const itemsPayload = items.map((item: OrderItemInput, idx: number) => ({
      item: {
        product_id: item.product?.id ?? null,
        product_name: item.product?.name ?? (item as any).product_name ?? 'Item',
        category_name: Array.isArray(item.product?.categories)
          ? (item.product.categories[0]?.name ?? null)
          : ((item.product as any)?.categories?.name ?? (item as any).category_name ?? null),
        unit_price: authLines[idx].unitPrice,
        quantity: item.quantity,
        subtotal: authLines[idx].lineTotal,
        notes: item.notes ?? null,
      },
      variants: (item.selectedVariants ?? []).map((v: { groupName: string; optionName: string; priceAdjustment?: number }) => ({
        variant_group_name: v.groupName,
        variant_option_name: v.optionName,
        price_adjustment: v.priceAdjustment ?? 0,
      })),
      modifiers: (item.selectedModifiers ?? []).map((m: { groupName: string; optionName: string; price?: number }) => ({
        modifier_group_name: m.groupName,
        modifier_option_name: m.optionName,
        price: m.price ?? 0,
      })),
    }));

    const paymentsPayload = paymentLegs.map((leg: PaymentLegInput) => ({
      method:          leg.method,
      amount:          leg.amount,
      amount_tendered: leg.amount_tendered ?? leg.amount,
      change_given:    leg.change_given ?? 0,
      reference:       leg.reference ?? null,
      // An M-Pesa leg awaits the STK callback, so it is written 'pending' and the
      // callback flips it to 'completed' on payment (finding #5). Its amount is
      // still counted toward the reconciliation total — the money is promised —
      // but it is not marked collected until M-Pesa confirms. All other methods
      // are immediate and default to 'completed'.
      status:          leg.method === 'mpesa' ? 'pending' : 'completed',
    }));

    const orderPayload = {
      business_id: req.businessId,
      branch_id,
      customer_id: customer_id ?? null,
      customer_name: customer_name ?? null,
      customer_phone: customer_phone ?? null,
      order_number,
      order_type,
      delivery_person: order_type === 'delivery'
        ? (String(delivery_person ?? '').trim().slice(0, 120) || null)
        : null,
      subtotal: authSubtotal,
      vat_amount: authVat,
      ctl_amount: authCtl,
      discount_amount: authDiscount,
      discount_id: discount_id ?? null,
      loyalty_points_used: points_redeemed,
      total: authTotal,
      tip_amount: Math.max(0, Number(tip_amount) || 0),
      shift_id: resolvedShiftId,
      seated_at: order_type === 'dine_in' ? new Date().toISOString() : null,
      idempotency_key: idempotencyKey || crypto.randomUUID(),
      cashier_id: req.userId ?? null,
      device_id: req.body?.device_id ?? null,
      pump_id:         req.body?.pump_id ? String(req.body.pump_id) : null,
      // Offline sales carry their original timestamp so they book on the day they
      // actually happened, not at sync time (finding #7). Accept either field
      // name; a live sale sends neither and the RPC defaults to now().
      created_at: (req.body?.created_at || req.body?.client_created_at || null),
    };

    const { data: created, error: createErr } = await supabase.rpc('create_order_atomic', {
      p_order:    orderPayload,
      p_items:    itemsPayload,
      p_payments: paymentsPayload,
    });

    if (createErr) {
      if (createErr.code === '23505') {
        // Two different unique constraints can raise 23505 here:
        //   (business_id, idempotency_key) — a concurrent retry of the SAME
        //     order. The row already exists; return it as a duplicate (200).
        //   (business_id, branch_id, order_number) — a DIFFERENT order that
        //     happened to draw the same number (finding #20). No row matches our
        //     idempotency key, so surface a 409 the client can retry with a fresh
        //     number, rather than a 500. The widened generator makes this rare;
        //     this handles the rare case correctly instead of failing the sale.
        const { data: dup } = await supabase
          .from('orders')
          .select('id, order_number')
          .eq('business_id', req.businessId)
          .eq('idempotency_key', orderPayload.idempotency_key)
          .maybeSingle();
        if (dup) {
          res.status(200).json({ orderId: dup.id, orderNumber: dup.order_number, duplicate: true });
          return;
        }
        // Not our order → an order-number collision.
        res.status(409).json({
          error: 'Order number already exists — please retry.',
          code: 'ORDER_NUMBER_CONFLICT',
        });
        return;
      }
      // Everything below used to be `throw createErr`, which sendError turned
      // into "Failed to create order (ref: …)" — the same sentence for a bad
      // foreign key, a malformed uuid and a dead database. Eight of Beryl's
      // sales died there on 2026-08-07. The mapping now lives in
      // lib/orderErrors.ts so a test can drive it directly.
      const verdict = classifyOrderCreateError(createErr);

      console.error(
        `[order-create] ${createErr.code ?? '(no code)'} — ${verdict.detail}`,
        { businessId: req.businessId, branchId: branch_id, orderNumber: order_number,
          cashierId: req.userId, shiftId: resolvedShiftId,
          customerId: orderPayload.customer_id, discountId: orderPayload.discount_id,
          pumpId: orderPayload.pump_id, createdAt: orderPayload.created_at },
      );

      // Unknown class: rethrow so sendError logs it with a ref, unchanged.
      if (verdict.rethrow) throw createErr;

      res.status(verdict.status).json({
        error: verdict.message,
        ...(verdict.code ? { code: verdict.code } : {}),
        ...(process.env.NODE_ENV === 'production' ? {} : { detail: verdict.detail }),
      });
      return;
    }

    const createdRow = Array.isArray(created) ? created[0] : created;
    const order = {
      id: createdRow.order_id,
      order_number: createdRow.order_number,
      pump_id: req.body?.pump_id ? String(req.body.pump_id) : null,
    } as { id: string; order_number: string; pump_id: string | null };

    // orderItems is re-read for the post-commit steps that need item ids (stock,
    // recipe deduction). One extra read, off the critical write path.
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('id, product_id, quantity')
      .eq('order_id', order.id);

    // 6. Stock deduction — shared with the dine-in path.
    // This was 410 lines inline. /pay had a four-line imitation that updated
    // stock_levels.quantity only: no track_stock check, no sold_by='piece', no
    // stock_movements row, and no recipe, variant, packaging or fuel deduction.
    // Restaurants use /pay, so the recipe system was bypassed on the one path
    // that needed it. Both paths now call the same function.
    await applyStockEffects({
      businessId:  req.businessId,
      branchId:    branch_id,
      userId:      req.userId,
      orderId:     order.id,
      orderNumber: order_number,
      orderType:   order_type,
      pumpId:      order.pump_id ?? null,
      lines: items.map((i: OrderItemInput) => ({
        productId: i.product?.id ?? null,
        quantity:  Number(i.quantity) || 0,
        variants:  i.selectedVariants ?? [],
      })),
    });


    // 7. Kitchen ticket
    const { error: ktErr } = await supabase
      .from('kitchen_tickets')
      .insert({ order_id: order.id, branch_id, status: 'new' });
    if (ktErr) console.error('Failed to create kitchen ticket:', ktErr.message);

    // 7b. Low-stock alerts now fire inside applyStockEffects, so the dine-in
    //     path gets them too — it never did before.

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
      // total_spent is numeric(12,2), which PostgREST returns as a STRING. The
      // old code did `"1500.00" + 890`, which concatenates to "1500.00890"
      // rather than adding — so total_spent effectively never grew and every
      // RFM / CRM segment built on it was reading a dead column. Both operands
      // are coerced with Number() before the addition.
      const { data: cSpent } = await supabase
        .from('customers')
        .select('total_spent')
        .eq('id', customer_id)
        .single();
      await supabase
        .from('customers')
        .update({ total_spent: Number(cSpent?.total_spent ?? 0) + Number(authTotal) })
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


// ── POST /api/orders/:id/refund ──────────────────────────────────────────────
//
// Give money back on a sale that legitimately happened (audit finding M3).
//
// Distinct from a void, and deliberately so:
//
//   VOID    "this sale should not have happened" — within 30 minutes, order
//           becomes 'voided', drops out of sales entirely.
//   REFUND  "the sale happened, the money is going back" — any time, order stays
//           'completed', reversal recorded against it.
//
// The distinction matters for tax and for reporting. A voided order was never a
// sale; a refunded one was, and the VAT and levy on it were charged and are a
// real position for the period in which they were taken.
//
// Full refunds only. A partial needs line-level selection to restore the right
// stock and to recompute the tax split, and half-right money handling is worse
// than none — staff can refund in full and re-ring what the customer keeps.
router.post('/:id/refund', requirePermission('orders.void'), async (req, res) => {
  const { reason, override_pin, supervisor_pin, authorizer_id } = req.body;
  const orderId = req.params.id;

  if (!reason || !String(reason).trim()) {
    res.status(400).json({ error: 'A reason is required to refund an order' });
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
  if (order.status === 'voided') {
    res.status(400).json({ error: 'That order was voided — there is nothing to refund' });
    return;
  }
  if (order.status !== 'completed') {
    res.status(400).json({ error: 'Only a completed sale can be refunded' });
    return;
  }
  if (order.refunded_at) {
    res.status(400).json({ error: 'That order has already been refunded' });
    return;
  }

  // What was actually taken, per leg. Refunding is bounded by this rather than
  // by the order total: if a leg failed, that money never arrived and must not
  // be handed back.
  const completedPayments = (order.payments ?? []).filter(
    (p: { status: string; amount: string; method: string }) => p.status === 'completed',
  );
  const takenTotal = completedPayments.reduce(
    (sum: number, p: { amount: string }) => sum + (Number(p.amount) || 0), 0,
  );

  if (takenTotal <= 0) {
    res.status(400).json({ error: 'No completed payment on that order — nothing was taken' });
    return;
  }

  // Supervisor authorisation, exactly as for a void. Money leaving the drawer is
  // the event worth gating, and it is the same event in both cases.
  const ov = await verifyOverrideAuthorizer(req.businessId, authorizer_id, (override_pin ?? supervisor_pin) as string | undefined);
  let authorizedBy: string | null = null;

  if (ov.result === 'ok') {
    authorizedBy = ov.userId ?? null;
  } else if (ov.result === 'no_authorizers') {
    const legacy = await verifySupervisorPin(req.businessId, (override_pin ?? supervisor_pin) as string | undefined);
    if (legacy === 'not_configured') {
      res.status(400).json({
        error: 'No override PIN configured. Set one for a supervisor in Staff Management → Staff Members.',
        code:  'NO_OVERRIDE_CONFIGURED',
      });
      return;
    }
    if (!legacy) { res.status(403).json({ error: 'Invalid supervisor PIN' }); return; }
  } else {
    res.status(403).json({ error: 'Invalid override PIN, or the selected supervisor is not authorized' });
    return;
  }

  try {
    // 1. Reverse every completed leg, in the same tender it came in on, so the
    //    drawer reconciles per method. Cash back for cash; an M-Pesa leg is
    //    recorded here but must still be sent back through M-Pesa by hand.
    const { error: rErr } = await supabase
      .from('payments')
      .insert(completedPayments.map((leg: { method: string; amount: string }) => ({
        order_id: orderId,
        business_id: req.businessId,
        branch_id: order.branch_id,
        method: leg.method,
        amount: -Math.abs(Number(leg.amount) || 0),
        amount_tendered: 0,
        change_given: 0,
        reference: `REFUND-${order.order_number}`,
        status: 'refunded',
        sync_status: 'pending',
      })));
    if (rErr) throw rErr;

    // 2. Mark the order refunded. Status stays 'completed' on purpose — see
    //    migration 37.
    const { error: uErr } = await supabase
      .from('orders')
      .update({
        refunded_at:          new Date().toISOString(),
        refunded_amount:      round2(takenTotal),
        refund_reason:        String(reason).trim(),
        refunded_by:          req.userId,
        refund_authorized_by: authorizedBy,
      })
      .eq('id', orderId);
    if (uErr) throw uErr;

    // 3. Credit legs: clear the debt, same as a void.
    if (order.customer_id) {
      for (const leg of completedPayments.filter((l: { method: string }) => l.method === 'credit')) {
        const { error: crErr } = await supabase.rpc('apply_credit_transaction', {
          p_business_id:   req.businessId,
          p_customer_id:   order.customer_id,
          p_branch_id:     order.branch_id,
          p_order_id:      orderId,
          p_type:          'adjustment',
          p_amount:        -Math.abs(Number(leg.amount) || 0),
          p_method:        null,
          p_reference:     null,
          p_notes:         `Refund: ${order.order_number} — ${reason}`,
          p_created_by:    req.userId ?? null,
          p_enforce_limit: false,
        });
        if (crErr) console.error('[credit] refund reversal failed for order', orderId, crErr.message);
      }
    }

    // 4. Put the stock back. Goods are assumed returned; a refund where the
    //    customer keeps the food is a write-off, which is a stock adjustment and
    //    a different conversation.
    const productIds = (order.order_items ?? []).map((i: any) => i.product_id).filter(Boolean);
    if (productIds.length > 0) {
      const { data: tracked } = await supabase
        .from('products').select('id').in('id', productIds).eq('track_stock', true);
      const trackedIds = new Set((tracked ?? []).map((p: any) => p.id));

      for (const item of order.order_items ?? []) {
        if (!trackedIds.has(item.product_id)) continue;
        // Atomic restore. The old line wrapped item.quantity in Number() but
        // NOT stock.quantity, so "10.00" + Number(2) was still the string
        // "10.002". The RPC removes the JS addition entirely.
        const { data: restored, error: restoreErr } = await supabase.rpc('adjust_product_stock', {
          p_product_id:  item.product_id,
          p_branch_id:   order.branch_id,
          p_qty_delta:   Number(item.quantity),
          p_piece_delta: 0,
        });
        if (restoreErr) throw restoreErr;
        const restoredRow = Array.isArray(restored) ? restored[0] : restored;
        const newQty = Number(restoredRow?.quantity ?? 0);
        await supabase.from('stock_movements').insert({
          product_id: item.product_id,
          branch_id: order.branch_id,
          movement_type: 'correction',
          quantity_change: Number(item.quantity),
          quantity_after: newQty,
          notes: `Refund of Order ${order.order_number}: ${reason}`,
          // stock_movements has created_by, NOT cashier_id. The column does not
          // exist, so this insert was silently rejected and voided stock was
          // never restored to the ledger — the level was corrected, the audit
          // trail explaining why was not.
          created_by: req.userId,
        });
      }
    }

    res.json({
      ok: true,
      orderNumber: order.order_number,
      refunded: round2(takenTotal),
      byMethod: completedPayments.map((l: any) => ({ method: l.method, amount: Number(l.amount) || 0 })),
      authorizedBy,
    });
  } catch (err) {
    sendError(res, err, { message: 'Failed to refund order' });
  }
});

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

  // EVERY completed leg, not the first one.
  //
  // This used to be `.find(...)` — singular. A split tender (600 cash + 400
  // M-Pesa) reversed only the leg that happened to come back first, so 400 was
  // recorded as taken for a sale that never happened, and the credit reversal
  // below fired only if the credit leg was the one picked. Audit finding H3.
  const completedPayments = (order.payments ?? []).filter(
    (p: { id: string; status: string; amount: string; method: string }) => p.status === 'completed',
  );
  const isPaid = completedPayments.length > 0;

  let authorizedBy: string | null = null;
  if (isPaid) {
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

    // 2. Refund EVERY completed leg — one reversal row per leg, same method and
    // amount, so a split tender comes back in the same shape it went out and the
    // drawer reconciles per tender type rather than only in aggregate.
    if (isPaid) {
      const { error: rErr } = await supabase
        .from('payments')
        .insert(completedPayments.map((leg: { method: string; amount: string }) => ({
          order_id: orderId,
          business_id: req.businessId,
          branch_id: order.branch_id,
          method: leg.method,
          // Negate defensively: `amount` arrives as a string from PostgREST and
          // a leg that was somehow already negative must not flip positive.
          amount: -Math.abs(Number(leg.amount) || 0),
          amount_tendered: 0,
          change_given: 0,
          reference: `VOID-${order.order_number}`,
          status: 'refunded',
          sync_status: 'pending',
        })));
      if (rErr) throw rErr;

      // 2b. Reverse the credit charge (audit C5) — a voided credit sale must
      // not leave the debt standing. Runs for EVERY credit leg; previously it
      // fired only when credit happened to be the single leg `.find()` returned,
      // so a part-credit sale left the balance of the debt on the customer.
      //
      // Order is already voided/refunded above with no surrounding transaction
      // (see M7), so a failure here is logged, not thrown — the void itself
      // already succeeded and the client shouldn't be told otherwise.
      if (order.customer_id) {
        for (const leg of completedPayments.filter((l: { method: string }) => l.method === 'credit')) {
          const { error: crErr } = await supabase.rpc('apply_credit_transaction', {
            p_business_id:   req.businessId,
            p_customer_id:   order.customer_id,
            p_branch_id:     order.branch_id,
            p_order_id:      orderId,
            p_type:          'adjustment',
            p_amount:        -Math.abs(Number(leg.amount) || 0),
            p_method:        null,
            p_reference:     null,
            p_notes:         `Void: ${order.order_number} — ${reason}`,
            p_created_by:    req.userId ?? null,
            p_enforce_limit: false,
          });
          if (crErr) console.error('[credit] void reversal failed for order', orderId, crErr.message);
        }
      }
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

      // Atomic restore. The old code read quantity (a STRING) and added
      // item.quantity, producing "10.002.00" — an invalid numeric that made the
      // upsert fail silently, so a void NEVER put stock back. Deduction used
      // subtraction and coerced fine, which is why the shelf went down on a sale
      // and never came back up on a void.
      const { data: restored, error: restoreErr } = await supabase.rpc('adjust_product_stock', {
        p_product_id:  item.product_id,
        p_branch_id:   order.branch_id,
        p_qty_delta:   Number(item.quantity),
        p_piece_delta: 0,
      });
      if (restoreErr) throw restoreErr;
      const restoredRow = Array.isArray(restored) ? restored[0] : restored;
      const newQty = Number(restoredRow?.quantity ?? 0);

      await supabase
        .from('stock_movements')
        .insert({
          product_id: item.product_id,
          branch_id: order.branch_id,
          movement_type: 'correction',
          quantity_change: item.quantity,
          quantity_after: newQty,
          notes: `Void of Order ${order.order_number}: ${reason}`,
          created_by: req.userId,
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
    if (recomputeFailed(recomputed)) { res.status(recomputed.status).json({ error: recomputed.error }); return; }
    const { lines: authLines, subtotal: authSubtotal, total: authTotal, vat: authVat, ctl: authCtl } = recomputed;

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
        ctl_amount:      authCtl,
        total:           authTotal,
        discount_amount: 0,
        status:          'open',
        cashier_id:      req.userId,
        customer_id,
        customer_name,
        shift_id,
        seated_at:       order_type === 'dine_in' ? new Date().toISOString() : null,
        // This path set no idempotency_key whatsoever, so every dine-in order
        // carried NULL and duplicated on replay. See the note on POST / above.
        idempotency_key: crypto.randomUUID(),
        // 'synced', not 'pending' (audit H14). This row was created BY the cloud
        // and already lives in it — there is nothing left for it to sync to.
        // Writing 'pending' and never advancing it meant the tech panel reported
        // 100% of orders permanently pending and zero synced on every install,
        // and, worse, the LOCAL->CLOUD switch selects on sync_status='pending'
        // and so replayed the branch's ENTIRE order history on every switch.
        sync_status:     'synced',
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
    tip_amount = 0,
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
      // order_item_variants comes along because variant options carry stock
      // consequences — stock_factor scales the parent deduction, and
      // linked_product_id / linked_ingredient_id deduct something else entirely.
      // They are stored by NAME here, which applyStockEffects resolves via its
      // product|group|option key path.
      .select('*, order_items ( id, product_id, quantity, subtotal, product_name, category_name, unit_price, notes, order_item_variants ( variant_group_name, variant_option_name ) )')
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

    // ── Credit sale pre-check (audit C5) ──────────────────────────────────────
    // The order-first flow (dine-in) had no credit handling at all — a credit
    // leg here bypassed both the limit check and the balance write that
    // POST /orders already had (partially — see below). Mirrors that check.
    const creditLeg = paymentLegs.find(l => l.method === 'credit');
    let creditCustomerId: string | null = null;
    if (creditLeg) {
      creditCustomerId = customer_id ?? order.customer_id ?? null;
      if (!creditCustomerId) {
        res.status(400).json({ error: 'A customer is required for a credit sale' });
        return;
      }
      const creditAmount = Number(creditLeg.amount) || 0;
      const { data: cust } = await supabase
        .from('customers')
        .select('credit_limit, credit_balance')
        .eq('id', creditCustomerId).eq('business_id', req.businessId).single();
      if (!cust) { res.status(400).json({ error: 'Invalid customer' }); return; }
      const available = Number(cust.credit_limit) - Number(cust.credit_balance);
      if (creditAmount > available) {
        res.status(400).json({
          error: `Credit limit exceeded. Available: ${available.toFixed(2)}, required: ${creditAmount.toFixed(2)}`,
        });
        return;
      }
    }

    // ── Recompute the money as a SET before anything is written (audit H2) ───
    // This path used to write discount_amount alone while total and vat_amount
    // kept the figures computed at /open. The books then did not foot: subtotal
    // minus discount did not equal total, and VAT was overstated because it had
    // been charged on the pre-discount figure. Every order-first (dine-in) sale
    // carrying a discount was affected, and the error is in the operator's
    // favour, which is the direction a tax authority notices.
    //
    // Line prices are deliberately NOT re-derived here. `order.subtotal` was
    // already computed authoritatively by recomputeOrderTotals at /open, from
    // the catalogue. Re-deriving it would mean rebuilding the lines from
    // order_items, which this handler does not load with their variants and
    // modifiers — so a rebuild would silently drop every variant and modifier
    // price adjustment and quietly LOWER the bill. Discount and tax are the only
    // things that change here, so they are the only things recomputed.
    const paySubtotal = Number(order.subtotal) || 0;
    const payDiscount = capDiscount(discount_amount, paySubtotal);
    const payTotal    = round2(paySubtotal - payDiscount);
    const { vat: payVat, ctl: payCtl } = await taxSplit(req.businessId, payTotal);

    // Validate the legs reconcile to the recomputed total BEFORE writing them.
    // POST /orders enforces this inside create_order_atomic and REJECTS a
    // mismatch; /pay only logged it (checkPaymentIntegrity), so the two order
    // paths disagreed on whether a wrong-amount order could be completed
    // (finding #14). They now agree: a mismatch here is a 400, nothing is
    // written, and the order stays open to be paid correctly. A one-cent
    // tolerance absorbs rounding. NOTE: if any client sends legs that include a
    // tip in the leg amount, fix it to send legs summing to total (tip is a
    // separate field) BEFORE deploying — see the deploy note for the atomic
    // order fix; the same caution applies here.
    // A tip is money on top of the bill: it belongs in the legs (it is what the
    // customer handed over) but NOT in orders.total (which is what the business
    // recognises, and the base the VAT split is taken from). Reconcile against
    // total + tip. This matches create_order_atomic as of migration 66 — the two
    // order paths must agree on what "paid in full" means, or a sale that is
    // accepted at the counter is refused on the dine-in path and vice versa.
    const payTip = Math.max(0, Number(tip_amount) || 0);
    const amountDue = round2(payTotal + payTip);
    const legSum = paymentLegs.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    if (Math.abs(legSum - amountDue) > 0.01) {
      res.status(400).json({
        error: `Payment legs sum to ${legSum.toFixed(2)} but the amount due is ${amountDue.toFixed(2)} `
             + `(total ${payTotal.toFixed(2)} + tip ${payTip.toFixed(2)}).`,
        code: 'PAYMENT_MISMATCH',
      });
      return;
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

    // ── 2. CLAIM THE ORDER BEFORE WRITING ANYTHING (audit B1) ────────────────
    //
    // The status check above is a READ. Between that read and the write below
    // there was nothing stopping a second request doing the same thing: a
    // double-tapped Charge button, or the till retrying after a timeout on a
    // request that had actually succeeded. Both requests passed the check, both
    // inserted payment legs, both ran applyStockEffects, both awarded loyalty.
    // Net effect: the drawer over-reports, stock under-reports, and the customer
    // earns points twice — none of it visible until close.
    //
    // POST /orders has been safe from this since migration 54: an idempotency
    // key with a partial unique index behind it. /pay has never had either.
    //
    // The fix is to make the STATUS TRANSITION the lock. `.eq('status','open')`
    // means exactly one request can move the row out of 'open'; PostgREST
    // applies that as a WHERE on the UPDATE, so the loser matches no rows and
    // changes nothing. `.select()` is what makes the outcome legible — without
    // it supabase-js returns no rows and a lost claim is indistinguishable from
    // a won one.
    //
    // The claim happens FIRST, before the payment legs, because the legs are the
    // thing we must not write twice. Losing the claim now costs nothing.
    const orderUpdate: Record<string, unknown> = {
      status:          'completed',
      discount_amount: payDiscount,
      total:           payTotal,
      vat_amount:      payVat,
      ctl_amount:      payCtl,
      discount_id,
      // The dine-in path never stored the tip at all — a tip taken at the table
      // was money in the drawer that the books had no record of, which reads as
      // an unexplained cash surplus at close.
      tip_amount:      payTip,
      // Points redeemed on this order. The counter path has always written this
      // (it is read back by GET /orders); the dine-in path never did, so every
      // table order reported zero points redeemed however many were taken.
      loyalty_points_used: Math.max(0, Number(points_redeemed) || 0),
      sync_status:     'pending',
    };
    // Only touch customer_id if this request actually supplied one — don't
    // clobber whatever was set when the order was opened.
    if (customer_id) orderUpdate.customer_id = customer_id;

    const { data: claimed, error: uErr } = await supabase
      .from('orders')
      .update(orderUpdate)
      .eq('id', order.id)
      .eq('status', 'open')      // ← the lock
      .select('id, order_number, total, tip_amount');

    if (uErr) { sendError(res, uErr); return; }

    if (!claimed || claimed.length === 0) {
      // We lost the claim. Somebody else paid this order between our read and
      // our write.
      //
      // DELIBERATELY NOT AN ERROR. The order is paid and the drawer is shut.
      // Telling the cashier "that failed" when the money is in the till is the
      // worse outcome by a distance — they re-charge, and now there are two
      // sales. So we return exactly what the winning request returned and the
      // cashier never learns there was a race.
      //
      // The one thing we do NOT do is stay silent about a genuine discrepancy.
      // If the winner settled a different amount, this was not a duplicate of
      // our request — it was a different payment — and that belongs in front of
      // whoever reconciles the day, not in front of the cashier mid-service.
      const { data: settled } = await supabase
        .from('orders')
        .select('id, order_number, status, total, tip_amount')
        .eq('id', order.id)
        .single();

      const settledDue = round2(Number(settled?.total ?? 0) + Number(settled?.tip_amount ?? 0));
      if (settled && Math.abs(settledDue - amountDue) > 0.01) {
        await supabase.from('payment_exceptions').insert({
          business_id:     req.businessId,
          order_id:        order.id,
          expected_amount: amountDue,
          received_amount: settledDue,
          reason:
            'Concurrent /pay on the same order settled a different amount. The first '
            + 'request won and its figures stand. This request was not applied.',
        }).then(() => {}, e => console.error('[pay] exception log failed:', e));
        console.warn(`[pay] concurrent settle mismatch on ${order.order_number}: `
                   + `this request ${amountDue}, settled ${settledDue}`);
      }

      res.json({ orderId: order.id, orderNumber: order.order_number, duplicate: true });
      return;
    }

    // ── 2b. We own the order. Now it is safe to write the money. ─────────────
    const { error: pErr } = await supabase.from('payments').insert(paymentRows);
    if (pErr) { sendError(res, pErr); return; }

    checkPaymentIntegrity(order.order_number, order.id, payTotal, paymentRows);

    // 3b. Credit sale — record the debt (audit C5). Same RPC and same
    // log-and-continue pattern as POST /orders' equivalent block: the order
    // is already marked completed above with no surrounding transaction
    // (M7), so a failure here is logged, not thrown.
    if (creditLeg) {
      const { error: creditErr } = await supabase.rpc('apply_credit_transaction', {
        p_business_id:   req.businessId,
        p_customer_id:   creditCustomerId,
        p_branch_id:     order.branch_id,
        p_order_id:      order.id,
        p_type:          'charge',
        p_amount:        Math.abs(Number(creditLeg.amount) || 0),
        p_method:        null,
        p_reference:     null,
        p_notes:         `Credit sale ${order.order_number}`,
        p_created_by:    req.userId ?? null,
        p_enforce_limit: true,
      });
      if (creditErr) console.error('[credit] charge failed for order', order.id, creditErr.message);
    }

    // 4. Stock — the SAME effects POST /orders applies.
    //
    // What was here before: a loop that read stock_levels and wrote back
    // quantity - item.quantity. That is all. It ignored track_stock, so it
    // decremented products explicitly marked as untracked. It ignored
    // sold_by='piece', so piece-sold products lost whole units instead of
    // pieces. It wrote no stock_movements row, so none of it was auditable.
    // And it did no recipe, variant-linked, packaging or fuel deduction at all.
    //
    // Restaurants are the businesses that use this path, and restaurants are
    // the businesses with recipes — so the recipe system was bypassed on the
    // one path built for it. Every dine-in service overstated ingredient stock
    // silently.
    await applyStockEffects({
      businessId:  req.businessId,
      branchId:    order.branch_id,
      userId:      req.userId,
      orderId:     order.id,
      orderNumber: order.order_number,
      orderType:   order.order_type,
      pumpId:      order.pump_id ?? null,
      lines: (order.order_items ?? []).map((it: any) => ({
        productId: it.product_id ?? null,
        quantity:  Number(it.quantity) || 0,
        // Rebuilt from the DB, so names only — no optionId. lineStockImpact
        // falls back to the product|group|option key, which is why that lookup
        // is keyed both ways.
        variants: (it.order_item_variants ?? []).map((v: any) => ({
          groupName:  v.variant_group_name,
          optionName: v.variant_option_name,
        })),
      })),
    });

    // ── 5. Loyalty — THE SAME loyalty POST /orders applies (audit B2) ────────
    //
    // BUG-07 fixed redemption here and left the award side alone, so the two
    // order paths drifted into disagreeing about almost everything:
    //
    //   earn formula      counter: floor(total/10) x earnRate   here: floor(total/100)
    //   tier multiplier   counter: applied                      here: ignored
    //   ledger row        counter: written                      here: none
    //   total_spent       counter: updated                      here: never
    //
    // With the default earn rate of 1 that is a TEN-FOLD difference: a KES 1,000
    // bill earned 100 points at the counter and 10 at the table. Same customer,
    // same spend, different answer depending on where they sat. And because no
    // loyalty_transactions row was written, the balance could not be reconciled
    // against the ledger to notice.
    //
    // total_spent matters beyond loyalty: it is what every RFM and CRM segment
    // is built on. Its string-concatenation bug was fixed on the counter path
    // and the column stayed dead here — for restaurants, which are the
    // businesses that use this path at all.
    if (customer_id) {
      // 5a. Deduct redeemed points.
      //
      // adjust_loyalty_points (migration 67) is deliberately NOT
      // increment_loyalty_points with a negative number — that one also does
      // visit_count + 1, which would count a redemption as another visit and
      // double-count any order that both redeems and earns.
      //
      // (What this replaced: .update({ loyalty_points: supabase.rpc('decrement') }).
      // supabase.rpc() returns a lazy query BUILDER, never awaited, serialised
      // into the update body as JSON, result not destructured. No such function
      // exists in any migration. Customers redeemed their points and kept them.)
      const redeemPts = Math.max(0, Number(points_redeemed) || 0);
      if (redeemPts > 0) {
        const { error: redeemErr } = await supabase.rpc('adjust_loyalty_points', {
          p_customer_id: customer_id,
          p_points:      -redeemPts,
        });
        if (redeemErr) {
          console.error('[orders/pay] loyalty redemption failed:', redeemErr.message);
        } else {
          // The ledger row the counter path has always written. Without it the
          // points balance is a number with no history behind it.
          await supabase
            .from('loyalty_transactions')
            .insert({
              customer_id,
              business_id: req.businessId,
              order_id:    order.id,
              type:        'redeem',
              points:      -redeemPts,
              notes:       `Redeemed on order ${order.order_number}`,
            });
        }
      }

      // 5b. Earn on the net total, at the business's configured rate, with the
      //     customer's tier multiplier. Identical arithmetic to POST /orders —
      //     if that formula ever changes it must change in one place, which is
      //     why both paths now read it from the same helpers.
      //
      //     payTotal, not order.total: order.total is the pre-discount figure
      //     this handler has just superseded, so awarding on it would earn the
      //     customer points for money nobody paid.
      const earnRate = await getLoyaltyEarnRate(req.businessId);
      const { data: customerForTier } = await supabase
        .from('customers')
        .select('loyalty_points')
        .eq('id', customer_id)
        .single();

      const { multiplier } = getTier(Number(customerForTier?.loyalty_points ?? 0));
      const basePoints   = Math.floor(payTotal / 10) * earnRate;
      const pointsToEarn = Math.floor(basePoints * multiplier);

      // awardLoyaltyPoints, not a bare rpc(): it carries the PGRST202 fallback
      // AND writes the loyalty_transactions row. Calling the RPC directly is
      // what left dine-in awards out of the ledger.
      if (pointsToEarn > 0) {
        await awardLoyaltyPoints(customer_id, req.businessId, order.id, pointsToEarn, order.order_number);
      }

      // 5c. total_spent. numeric(12,2) arrives from PostgREST as a STRING, so
      //     both operands are coerced before the addition — "1500.00" + 890
      //     concatenates to "1500.00890" rather than adding, which is how this
      //     column died on the counter path before it was fixed there.
      const { data: cSpent } = await supabase
        .from('customers')
        .select('total_spent')
        .eq('id', customer_id)
        .single();
      await supabase
        .from('customers')
        .update({ total_spent: Number(cSpent?.total_spent ?? 0) + Number(payTotal) })
        .eq('id', customer_id)
        .eq('business_id', req.businessId);
    }

    // 6. Increment discount usage
    if (discount_id) {
      await supabase.rpc('increment_discount_usage', { discount_uuid: discount_id });
    }

    // 7. Fire webhook — non-blocking
    fireWebhook(req.businessId, 'order.completed', {
      order_id: order.id, order_number: order.order_number,
      order_type: order.order_type, total: payTotal,
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
