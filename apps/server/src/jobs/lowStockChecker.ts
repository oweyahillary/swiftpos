import { supabase } from '../lib/supabase';
import { sendEmail } from '../lib/mailer';

/**
 * Check stock levels for the given product IDs after a sale.
 * For each product whose quantity has dropped below its low_stock_threshold:
 *   1. Write a 'low_stock' notification row (deduped — skip if unread one exists)
 *   2. Send an alert email to the business owner
 *
 * Called from POST /api/orders after stock deduction completes.
 */
export async function checkLowStock(
  businessId: string,
  branchId: string,
  productIds: string[],
): Promise<void> {
  if (!productIds.length) return;

  try {
    // 1. Fetch current stock levels + thresholds for affected products
    const { data: levels, error: lErr } = await supabase
      .from('stock')
      .select('product_id, quantity, low_stock_threshold')
      .eq('branch_id', branchId)
      .in('product_id', productIds);

    if (lErr || !levels?.length) return;

    // 2. Filter to only those below threshold
    const lowItems = levels.filter(l => l.quantity < l.low_stock_threshold);
    if (!lowItems.length) return;

    // 3. Fetch product names for the low items
    const lowProductIds = lowItems.map(l => l.product_id);
    const { data: products } = await supabase
      .from('products')
      .select('id, name')
      .in('id', lowProductIds);

    const productMap = new Map((products ?? []).map(p => [p.id, p.name]));

    // 4. Fetch business owner email + business name
    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, owner_id')
      .eq('id', businessId)
      .single();

    let ownerEmail: string | null = null;
    if (business?.owner_id) {
      const { data: { user } } = await supabase.auth.admin.getUserById(business.owner_id);
      ownerEmail = user?.email ?? null;
    }

    // 5. For each low-stock item: dedupe + notify
    for (const item of lowItems) {
      const productName = productMap.get(item.product_id) ?? 'Unknown product';

      // Dedupe: skip if an unread low_stock notification already exists for this product
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('business_id', businessId)
        .eq('type', 'low_stock')
        .ilike('message', `%${item.product_id}%`)
        .is('read_at', null)
        .maybeSingle();

      if (existing) continue;

      const title = `Low stock: ${productName}`;
      const message = `${productName} [${item.product_id}] is down to ${item.quantity} unit${item.quantity !== 1 ? 's' : ''} (threshold: ${item.low_stock_threshold}).`;

      // 5a. Write in-app notification
      await supabase
        .from('notifications')
        .insert({
          business_id: businessId,
          user_id: business?.owner_id ?? null,
          type: 'low_stock',
          title,
          message,
          link: '/dashboard/inventory',
        });

      // 5b. Send email alert if owner email is available
      if (ownerEmail) {
        await sendEmail({
          to: ownerEmail,
          subject: `⚠️ Low stock alert — ${productName}`,
          html: buildLowStockEmail({
            businessName: business?.name ?? 'Your business',
            productName,
            quantity: item.quantity,
            threshold: item.low_stock_threshold,
          }),
        }).catch(err => {
          // Non-blocking — log but don't fail the order
          console.error('[lowStockChecker] Email failed:', err.message);
        });
      }
    }
  } catch (err: any) {
    // Never let notification errors bubble up and break order creation
    console.error('[lowStockChecker] Unexpected error:', err.message);
  }
}

/**
 * Check ingredient stock levels after a sale deduction.
 * Fires a low_stock notification for any ingredient below its reorder_level.
 * Called from POST /api/orders — non-blocking, never throws.
 */
export async function checkLowIngredients(
  businessId: string,
  ingredientIds: string[],
): Promise<void> {
  if (!ingredientIds.length) return;

  try {
    const { data: ingredients } = await supabase
      .from('ingredients')
      .select('id, name, current_stock, reorder_level')
      .eq('business_id', businessId)
      .in('id', ingredientIds)
      .gt('reorder_level', 0); // only check those with a reorder level set

    if (!ingredients?.length) return;

    const lowItems = ingredients.filter(i => Number(i.current_stock) <= Number(i.reorder_level));
    if (!lowItems.length) return;

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, owner_id')
      .eq('id', businessId)
      .single();

    let ownerEmail: string | null = null;
    if (business?.owner_id) {
      const { data: { user } } = await supabase.auth.admin.getUserById(business.owner_id);
      ownerEmail = user?.email ?? null;
    }

    for (const item of lowItems) {
      // Dedupe: skip if unread alert already exists for this ingredient
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('business_id', businessId)
        .eq('type', 'low_stock')
        .ilike('message', `%${item.id}%`)
        .is('read_at', null)
        .maybeSingle();

      if (existing) continue;

      const isOut = Number(item.current_stock) <= 0;
      const title = isOut
        ? `Out of stock: ${item.name}`
        : `Low ingredient: ${item.name}`;
      const message = isOut
        ? `${item.name} [${item.id}] is out of stock. Reorder level: ${item.reorder_level}.`
        : `${item.name} [${item.id}] is at ${item.current_stock} (reorder level: ${item.reorder_level}).`;

      await supabase.from('notifications').insert({
        business_id: businessId,
        user_id:     business?.owner_id ?? null,
        type:        'low_stock',
        title,
        message,
        link:        '/dashboard/stock/ingredients',
      });

      if (ownerEmail) {
        await sendEmail({
          to:      ownerEmail,
          subject: `⚠️ ${isOut ? 'Out of stock' : 'Low ingredient'} — ${item.name}`,
          html:    buildLowIngredientEmail({
            businessName: business?.name ?? 'Your business',
            ingredientName: item.name,
            currentStock:  Number(item.current_stock),
            reorderLevel:  Number(item.reorder_level),
          }),
        }).catch(err => console.error('[lowStockChecker] Ingredient email failed:', err.message));
      }
    }
  } catch (err: any) {
    console.error('[lowStockChecker] checkLowIngredients error:', err.message);
  }
}

// ── Email template ────────────────────────────────────────────
function buildLowIngredientEmail(opts: {
  businessName: string;
  ingredientName: string;
  currentStock: number;
  reorderLevel: number;
}): string {
  const isOut = opts.currentStock <= 0;
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="padding-bottom:24px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#22c55e;">SwiftPOS</p>
          <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">${opts.businessName}</p>
        </td></tr>
        <tr><td style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:32px;">
          <p style="margin:0 0 8px;font-size:28px;">${isOut ? '🚫' : '⚠️'}</p>
          <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#ffffff;">${isOut ? 'Ingredient out of stock' : 'Low ingredient alert'}</h1>
          <p style="margin:0 0 24px;font-size:14px;color:#9ca3af;">Place a purchase order to restock.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:24px;">
            <tr>
              <td>
                <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#ffffff;">${opts.ingredientName}</p>
                <p style="margin:0;font-size:13px;color:#6b7280;">Current stock</p>
              </td>
              <td align="right">
                <p style="margin:0;font-size:24px;font-weight:700;color:${isOut ? '#ef4444' : '#f97316'};">${opts.currentStock}</p>
                <p style="margin:0;font-size:12px;color:#6b7280;">reorder at: ${opts.reorderLevel}</p>
              </td>
            </tr>
          </table>
          <a href="${process.env.DASHBOARD_URL ?? 'https://app.swiftpos.co.ke'}/dashboard/stock/ingredients"
             style="display:inline-block;background:#22c55e;color:#000;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">
            View ingredients →
          </a>
        </td></tr>
        <tr><td style="padding-top:24px;">
          <p style="margin:0;font-size:11px;color:#374151;text-align:center;">Sent by SwiftPOS · ${opts.businessName}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Product low-stock email template ─────────────────────────
function buildLowStockEmail(opts: {
  businessName: string;
  productName: string;
  quantity: number;
  threshold: number;
}): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <!-- Header -->
          <tr>
            <td style="padding-bottom:24px;">
              <p style="margin:0;font-size:20px;font-weight:700;color:#22c55e;">SwiftPOS</p>
              <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">${opts.businessName}</p>
            </td>
          </tr>

          <!-- Alert card -->
          <tr>
            <td style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:32px;">
              <p style="margin:0 0 8px;font-size:28px;">⚠️</p>
              <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#ffffff;">Low stock alert</h1>
              <p style="margin:0 0 24px;font-size:14px;color:#9ca3af;">Action may be needed to avoid running out.</p>

              <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:24px;">
                <tr>
                  <td>
                    <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#ffffff;">${opts.productName}</p>
                    <p style="margin:0;font-size:13px;color:#6b7280;">Current stock</p>
                  </td>
                  <td align="right">
                    <p style="margin:0;font-size:24px;font-weight:700;color:#f97316;">${opts.quantity}</p>
                    <p style="margin:0;font-size:12px;color:#6b7280;">threshold: ${opts.threshold}</p>
                  </td>
                </tr>
              </table>

              <a href="${process.env.DASHBOARD_URL ?? 'https://app.swiftpos.co.ke'}/dashboard/inventory"
                 style="display:inline-block;background:#22c55e;color:#000;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">
                View inventory →
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:24px;">
              <p style="margin:0;font-size:11px;color:#374151;text-align:center;">
                Sent by SwiftPOS · You're receiving this because you own ${opts.businessName}
                <!-- TODO (Step 19/21): Replace sender with business domain email -->
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
