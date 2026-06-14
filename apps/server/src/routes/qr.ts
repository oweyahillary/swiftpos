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
import { safeRouter } from '../middleware/asyncHandler';
import { supabase }    from '../lib/supabase';
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
    .select('id, name, description, price, image_url, category_id, has_modifiers')
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
    .select('id, qr_ordering')
    .eq('menu_slug', slug)
    .single();

  if (!biz || !biz.qr_ordering) {
    res.status(403).json({ error: 'QR ordering is disabled' });
    return;
  }

  // Calculate totals
  let subtotal = 0;
  const orderItems: any[] = [];
  for (const item of items) {
    const { data: product } = await supabase
      .from('products')
      .select('id, name, price, vat_rate')
      .eq('id', item.product_id)
      .eq('business_id', biz.id)
      .single();

    if (!product) continue;
    const lineTotal = product.price * item.quantity;
    subtotal += lineTotal;
    orderItems.push({
      product_id:   product.id,
      product_name: product.name,
      quantity:     item.quantity,
      unit_price:   product.price,
      subtotal:     lineTotal,
      modifier_summary: item.modifier_summary || null,
      notes: item.notes || null,
    });
  }

  const vatRate = 0.16;
  const vatAmount = subtotal * vatRate;
  const total = subtotal + vatAmount;

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
      total,
      table_id:     table_id || null,
      notes:        [guest_name ? `Guest: ${guest_name}` : '', notes].filter(Boolean).join(' · ') || null,
    })
    .select('id, order_number')
    .single();

  if (oErr) { res.status(500).json({ error: oErr.message }); return; }

  // Insert order items
  await supabase.from('order_items').insert(
    orderItems.map(item => ({ ...item, order_id: order.id }))
  );

  // Push to KDS
  await supabase.from('kitchen_tickets').insert({
    business_id:  biz.id,
    branch_id,
    order_id:     order.id,
    order_number: order.order_number,
    order_type:   'dine_in',
    table_id:     table_id || null,
    source:       'qr',
    status:       'pending',
    items: orderItems.map(i => ({
      product_id: i.product_id, name: i.product_name,
      quantity: i.quantity, notes: i.notes,
    })),
  }).catch(() => {});  // non-blocking

  res.status(201).json({ order_id: order.id, order_number: order.order_number });
});

// ── QR settings (auth required) ───────────────────────────────────────────────

router.get('/settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('businesses')
    .select('menu_slug, qr_ordering')
    .eq('id', req.businessId)
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
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

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;
