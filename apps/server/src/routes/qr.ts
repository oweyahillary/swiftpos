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

const router = safeRouter();

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
    .select('id, name, description, price:base_price, image_url, category_id, has_modifiers')
    .eq('business_id', biz.id)
    .eq('status', 'active')
    .eq('is_combo', false)   // don't show raw combo-only items
    .order('name');

  // Get table name if provided
  let tableName: string | null = null;
  if (table_id) {
    const { data: table } = await supabase
      .from('tables')
      .select('name')
      .eq('id', table_id as string)
      .single();
    tableName = table?.name ?? null;
  }

  res.json({
    business: { id: biz.id, name: biz.name, currency: biz.currency },
    table_id:  table_id ?? null,
    table_name: tableName,
    categories: categories ?? [],
    products:   products ?? [],
  });
});

// ── Place QR order (no auth) ──────────────────────────────────────────────────

router.post('/:slug/order', async (req, res) => {
  const { slug } = req.params;
  const { table_id, branch_id, items, guest_name, notes } = req.body;

  if (!items?.length) { res.status(400).json({ error: 'items are required' }); return; }
  if (!branch_id)     { res.status(400).json({ error: 'branch_id is required' }); return; }

  const { data: biz } = await supabase
    .from('businesses')
    .select('id, qr_ordering, vat_rate, ctl_rate')
    .eq('menu_slug', slug)
    .single();

  if (!biz || !biz.qr_ordering) {
    res.status(403).json({ error: 'QR ordering is disabled' });
    return;
  }

  // orders has no table_id column — it stores the table's display name in
  // table_number. Resolve it here; an unknown id leaves the order unassigned
  // rather than failing the whole insert.
  let tableNumber: string | null = null;
  if (table_id) {
    const { data: tbl } = await supabase
      .from('tables')
      .select('name')
      .eq('id', table_id)
      .eq('business_id', biz.id)
      .single();
    tableNumber = tbl?.name ?? null;
  }

  // Calculate totals
  let subtotal = 0;
  const orderItems: any[] = [];
  for (const item of items) {
    const { data: product } = await supabase
      .from('products')
      .select('id, name, base_price')
      .eq('id', item.product_id)
      .eq('business_id', biz.id)
      .single();

    if (!product) continue;
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
      notes: [item.modifier_summary, item.notes].filter(Boolean).join(' · ') || null,
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
      branch_id,
      order_number: orderNumber,
      order_type:   'dine_in',
      status:       'open',
      source:       'qr',
      subtotal,
      vat_amount:   vatAmount,
      ctl_amount:   ctlAmount,
      total,
      table_number: tableNumber,
      notes:        [guest_name ? `Guest: ${guest_name}` : '', notes].filter(Boolean).join(' · ') || null,
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
    branch_id,
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

router.patch('/settings', requireAuth, async (req, res) => {
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
