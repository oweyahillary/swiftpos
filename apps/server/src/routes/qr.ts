/**
 * routes/qr.ts
 * Public (no-auth) endpoints for QR self-ordering.
 *
 * GET  /api/qr/:slug              — public menu for a business
 * POST /api/qr/:slug/order        — place a QR order (creates open order for table)
 * GET  /api/qr/settings           — get/update QR settings (auth required)
 * PATCH /api/qr/settings          — update qr_ordering, menu_slug (auth required)
 */

import { Router } from 'express';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }    from '../lib/supabase';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { showsOnDay } from '../lib/productDays';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const router = safeRouter();

// ── A495: limits on the public order endpoint ─────────────────────────────────
// Anyone with the link can post an order (and a kitchen ticket). Per IP: 10 orders in 10 minutes is far more than a
// table orders, and stops a script filling a kitchen screen.
export const QR_LIMITS = { GUEST_NAME: 60, NOTES: 300, ITEM_NOTES: 200, ORDERS_PER_WINDOW: 10, WINDOW_MS: 10 * 60_000 } as const;
const qrOrderLimiter = rateLimit({
  windowMs: QR_LIMITS.WINDOW_MS,
  max: QR_LIMITS.ORDERS_PER_WINDOW,
  message: { error: 'Too many orders from this phone — please ask a member of staff.', code: 'QR_RATE_LIMIT' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
});

/** Optional text, trimmed, at most `max` characters; undefined when it is not text (refused by the caller). */
function cleanText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t.length > max) return undefined;
  return t || null;
}

/**
 * A495: the branch a QR order goes to — derived by the cloud, never trusted from the page. The table's own branch when
 * the QR names a table of this business; else the branch the link names (`branch`), when it is this business's and
 * open; else the business's main branch. null when the business has no open branch.
 */
async function qrBranch(businessId: string, tableId: unknown, branchId: unknown): Promise<{ branchId: string | null; tableName: string | null }> {
  let tableName: string | null = null;
  if (typeof tableId === 'string' && tableId) {
    const { data: table } = await supabase
      .from('tables').select('name, branch_id').eq('id', tableId).eq('business_id', businessId).maybeSingle();
    if (table) {
      tableName = (table as any).name ?? null;
      const { data: b } = await supabase.from('branches').select('id, status')
        .eq('id', (table as any).branch_id).eq('business_id', businessId).maybeSingle();
      if (b && (b as any).status === 'active') return { branchId: (b as any).id, tableName };
    }
  }
  if (typeof branchId === 'string' && branchId) {
    const { data: b } = await supabase.from('branches').select('id, status')
      .eq('id', branchId).eq('business_id', businessId).maybeSingle();
    if (b && (b as any).status === 'active') return { branchId: (b as any).id, tableName };
  }
  const { data: branches } = await supabase.from('branches').select('id, is_main, status')
    .eq('business_id', businessId).eq('status', 'active');
  const list = (branches ?? []) as Array<{ id: string; is_main: boolean | null }>;
  const main = list.find((b) => b.is_main) ?? (list.length === 1 ? list[0] : null);
  return { branchId: main?.id ?? null, tableName };
}

// ── Public menu endpoint (no auth) ────────────────────────────────────────────

router.get('/:slug/menu', async (req, res) => {
  const { slug } = req.params;
  const { table_id } = req.query;

  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, currency, qr_ordering')
    .eq('menu_slug', slug)
    .single();

  if (!biz || !biz.qr_ordering) {
    res.status(404).json({ error: 'Menu not found or QR ordering is disabled' });
    return;
  }

  // Get categories + active products
  const { data: categories } = await supabase
    .from('categories')
    .select('id, name, sort_order')
    .eq('business_id', biz.id)
    .eq('status', 'active')
    .order('sort_order');

  const { data: products } = await supabase
    .from('products')
    // PostgREST alias: the column is base_price; the public menu contract
    // (QRMenuPage.tsx Product.price) stays `price`.
    .select('id, name, description, price:base_price, image_url, category_id, has_modifiers, show_days')
    .eq('business_id', biz.id)
    .eq('status', 'active')
    .eq('is_combo', false)   // don't show raw combo-only items
    .order('name');
  // 0.6.31: a product shown only on chosen days is on the customer menu those days — the business's day (East Africa
  // Time, as the reports use: UTC+3, no daylight saving).
  const bizDay = new Date(Date.now() + 3 * 3600_000).getUTCDay();
  const menuProducts = (products ?? [])
    .filter((p: any) => showsOnDay(p.show_days, bizDay))
    .map(({ show_days: _days, ...p }: any) => p);

  // A495: the branch this QR orders for (the page sends it back with the order; the cloud derives it again there). The
  // table name is only ever this business's (audit 2026-10-14). The business's own id is not needed by the page.
  const { branchId, tableName } = await qrBranch(biz.id, table_id, req.query.branch);

  res.json({
    business: { name: biz.name, currency: biz.currency },
    branch_id: branchId,
    table_id:  table_id ?? null,
    table_name: tableName,
    categories: categories ?? [],
    products:   menuProducts,
  });
});

// ── Place QR order (no auth) ──────────────────────────────────────────────────

router.post('/:slug/order', qrOrderLimiter, async (req, res) => {
  const { slug } = req.params;
  const { table_id, branch_id, items } = req.body ?? {};

  // A495: an empty order is refused; texts are capped (they land on the kitchen ticket and the bill).
  if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: 'Add something to your order first' }); return; }
  if (items.length > 100) { res.status(400).json({ error: 'items must be a list of up to 100' }); return; }
  const guestName = cleanText(req.body?.guest_name, QR_LIMITS.GUEST_NAME);
  const notes = cleanText(req.body?.notes, QR_LIMITS.NOTES);
  if (guestName === undefined) { res.status(400).json({ error: `Your name can be up to ${QR_LIMITS.GUEST_NAME} characters` }); return; }
  if (notes === undefined) { res.status(400).json({ error: `Notes can be up to ${QR_LIMITS.NOTES} characters` }); return; }
  if (items.some((i: any) => !i || typeof i.product_id !== 'string' || !i.product_id
      || cleanText(i.notes, QR_LIMITS.ITEM_NOTES) === undefined || cleanText(i.modifier_summary, QR_LIMITS.ITEM_NOTES) === undefined)) {
    res.status(400).json({ error: `Each item needs a product, and its notes can be up to ${QR_LIMITS.ITEM_NOTES} characters` }); return;
  }
  // A quantity is a whole number from 1 to 99 — a negative one took money off the bill.
  if (items.some((i: any) => !Number.isInteger(i?.quantity) || i.quantity < 1 || i.quantity > 99)) {
    res.status(400).json({ error: 'Each item needs a quantity from 1 to 99' }); return;
  }

  const { data: biz } = await supabase
    .from('businesses')
    .select('id, qr_ordering, vat_rate, ctl_rate')
    .eq('menu_slug', slug)
    .single();

  if (!biz || !biz.qr_ordering) {
    res.status(403).json({ error: 'QR ordering is disabled' });
    return;
  }

  // Audit 2026-10-14 / A495: the branch is this business's and open — derived by the cloud (the table's branch, the
  // branch named, or the main branch), so an anonymous caller can never drop an order into another business's branch.
  // orders has no table_id column — it stores the table's display name in table_number (an unknown table leaves the
  // order unassigned rather than failing it).
  const { branchId: orderBranch, tableName: tableNumber } = await qrBranch(biz.id, table_id, branch_id);
  if (!orderBranch) { res.status(404).json({ error: 'Branch not found' }); return; }

  // A495: every product must be this business's, on sale — an unknown one refuses the order (it used to be dropped
  // silently, so the guest was told "ordered" for food the kitchen never saw).
  const ids = [...new Set(items.map((i: any) => String(i.product_id)))];
  const { data: found } = await supabase
    .from('products')
    .select('id, name, base_price')
    .eq('business_id', biz.id)
    .eq('status', 'active')
    .in('id', ids);
  const byId = new Map(((found ?? []) as Array<{ id: string; name: string; base_price: number }>).map((p) => [p.id, p]));
  if (ids.some((id) => !byId.has(id))) {
    res.status(400).json({ error: 'Something on your order is no longer on the menu — please reload the menu', code: 'UNKNOWN_PRODUCT' });
    return;
  }

  // Calculate totals
  let subtotal = 0;
  const orderItems: any[] = [];
  for (const item of items) {
    const product = byId.get(String(item.product_id))!;
    const unitPrice = Number(product.base_price);
    const lineTotal = round2(unitPrice * item.quantity);
    subtotal = round2(subtotal + lineTotal);
    // order_items has no modifier_summary column; notes is the free-text field.
    orderItems.push({
      product_id:   product.id,
      product_name: product.name,
      quantity:     item.quantity,
      unit_price:   unitPrice,
      subtotal:     lineTotal,
      notes: [cleanText(item.modifier_summary, QR_LIMITS.ITEM_NOTES), cleanText(item.notes, QR_LIMITS.ITEM_NOTES)].filter(Boolean).join(' · ') || null,
    });
  }

  // Mirror the till's tax model (routes/orders.ts): menu prices are inclusive of
  // BOTH taxes, so back the net out using the combined rate, then charge each on
  // that net. VAT was previously hardcoded at 16% here, ignoring the business's
  // configured rate, and the catering levy (migration 33) was never applied to a
  // QR order at all.
  const vatRate = Number((biz as any).vat_rate ?? 16);
  const ctlRate = Number((biz as any).ctl_rate ?? 0);
  const total     = subtotal;
  const net       = total / (1 + (vatRate + ctlRate) / 100);
  const vatAmount = round2(net * (vatRate / 100));
  const ctlAmount = round2(net * (ctlRate / 100));

  const orderNumber = `QR-${Date.now().toString(36).toUpperCase()}`;

  // Create open order (status: open — not yet paid)
  const { data: order, error: oErr } = await supabase
    .from('orders')
    .insert({
      business_id:  biz.id,
      branch_id:    orderBranch,
      order_number: orderNumber,
      order_type:   'dine_in',
      status:       'open',
      source:       'qr',
      subtotal,
      vat_amount:   vatAmount,
      ctl_amount:   ctlAmount,
      total,
      table_number: tableNumber,
      notes:        [guestName ? `Guest: ${guestName}` : '', notes].filter(Boolean).join(' · ') || null,
    })
    .select('id, order_number')
    .single();

  if (oErr) { sendError(res, oErr); return; }

  // Insert order items
  await supabase.from('order_items').insert(
    orderItems.map(item => ({ ...item, order_id: order.id }))
  );

  // Push to KDS
  // kitchen_tickets has exactly: id, order_id, branch_id, station, status,
  // printed_at, preparing_at, ready_at, collected_at, created_at.
  // Ticket contents are joined through orders -> order_items by kitchen.ts,
  // so the row is deliberately minimal. Every other field previously sent here
  // was phantom, and status:'pending' violated kitchen_tickets_status_check.
  const { error: ticketErr } = await supabase.from('kitchen_tickets').insert({
    order_id:  order.id,
    branch_id: orderBranch,
    status:    'new',
  });
  // Non-blocking for the customer, but never silent: a lost ticket means the
  // kitchen never sees a paid order.
  if (ticketErr) console.error('[qr] kitchen ticket insert failed:', ticketErr);

  res.status(201).json({ order_id: order.id, order_number: order.order_number });
});

// ── QR settings (auth required) ───────────────────────────────────────────────

router.get('/settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('businesses')
    .select('menu_slug, qr_ordering')
    .eq('id', req.businessId)
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

// Audit 2026-10-14: was requireAuth only — any signed-in user could switch public ordering on or take over the menu link.
router.patch('/settings', requireAuth, requirePermission('settings.integrations'), async (req, res) => {
  const { menu_slug, qr_ordering } = req.body;
  const updates: Record<string, unknown> = {};
  if (menu_slug   !== undefined) updates.menu_slug   = menu_slug?.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-') || null;
  if (qr_ordering !== undefined) updates.qr_ordering = Boolean(qr_ordering);

  const { data, error } = await supabase
    .from('businesses')
    .update(updates)
    .eq('id', req.businessId)
    .select('menu_slug, qr_ordering')
    .single();

  if (error) { sendError(res, error); return; }
  res.json(data);
});

export default router;
