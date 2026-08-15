import { supabase } from '../lib/supabase';
import { sendEmail } from '../lib/mailer';
import {
  classifyStockLevel,
  shouldResolveStockAlert,
  stockAlertMarker,
  type StockAlertType,
} from '../lib/stockAlerts';

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
    //
    // stock_levels, NOT stock (audit B6). The live schema carries BOTH tables
    // with near-identical columns. Every sale writes stock_levels — that is
    // where adjust_product_stock and applyStockEffects put the figures. This
    // job read `stock`, which nothing has written since the two diverged, so it
    // found stale rows or none at all and returned at the guard below without
    // a sound. Low-stock alerts have been dead, and every gate stayed green:
    // both tables exist in schema-index.json, so `.from('stock')` is a
    // perfectly legal query and the schema audit had no opinion about it.
    //
    // scripts/check-table-usage.mjs now fails on this shape.
    const { data: levels, error: lErr } = await supabase
      .from('stock_levels')
      .select('product_id, quantity, low_stock_threshold')
      .eq('branch_id', branchId)
      .in('product_id', productIds);

    // A query ERROR and an empty shelf are not the same event. Collapsing them
    // into one silent return is half of why this went unnoticed for so long.
    if (lErr) { console.error('[lowStock] level read failed:', lErr.message); return; }
    if (!levels?.length) return;

    // 2. Classify each level. classifyStockLevel handles the string-coercion
    // (audit C7) and the negative-vs-low split (register A74): a negative
    // on-hand is a DIFFERENT event from merely low — it means the till sold
    // past recorded stock, usually because a transfer arrived physically but
    // was never received in the system.
    const alerts = levels
      .map(l => ({ ...l, alertType: classifyStockLevel(l.quantity, l.low_stock_threshold) }))
      .filter((l): l is typeof l & { alertType: StockAlertType } => l.alertType !== null);
    if (!alerts.length) return;

    // 3. Fetch product names for the affected items
    const affectedIds = alerts.map(l => l.product_id);
    const { data: products } = await supabase
      .from('products')
      .select('id, name')
      .in('id', affectedIds);

    const productMap = new Map((products ?? []).map(p => [p.id, p.name]));

    // 4. Fetch business owner email + business name, and the branch name so the
    // manager-facing title/message names the branch the shortfall is at.
    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, owner_id')
      .eq('id', businessId)
      .single();

    const { data: branch } = await supabase
      .from('branches').select('name').eq('id', branchId).maybeSingle();
    const branchName = branch?.name ?? 'branch';

    let ownerEmail: string | null = null;
    if (business?.owner_id) {
      const { data: { user } } = await supabase.auth.admin.getUserById(business.owner_id);
      ownerEmail = user?.email ?? null;
    }

    // 5. For each affected item: dedupe + notify
    for (const item of alerts) {
      const productName = productMap.get(item.product_id) ?? 'Unknown product';
      const isNegative  = item.alertType === 'negative_stock';
      const marker      = stockAlertMarker(item.product_id, branchId);

      // Dedupe per product+branch AND per type: an unread alert of the SAME
      // type suppresses a duplicate, but a low alert must not hide a later
      // negative one for the same product (or vice versa). The marker embeds
      // the branch, so two branches never dedupe against each other.
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('business_id', businessId)
        .eq('type', item.alertType)
        .ilike('message', `%${marker}%`)
        .is('read_at', null)
        .maybeSingle();

      if (existing) continue;

      const title = isNegative
        ? `Sold beyond stock: ${productName} (${branchName})`
        : `Low stock: ${productName} (${branchName})`;
      const message = isNegative
        ? `${productName} ${marker} at ${branchName} shows ${item.quantity} — sold past recorded stock. If a transfer arrived, receive it to clear this.`
        : `${productName} ${marker} is down to ${item.quantity} unit${Number(item.quantity) !== 1 ? 's' : ''} at ${branchName} (threshold: ${item.low_stock_threshold}).`;

      // 5a. Write in-app notification. branch_id is set (the column existed and
      // was previously left null on the product path — register A74) so a
      // branch-scoped manager view can filter to its own branch.
      await supabase
        .from('notifications')
        .insert({
          business_id: businessId,
          branch_id:   branchId,
          user_id:     business?.owner_id ?? null,
          type:        item.alertType,
          title,
          message,
          link:        '/dashboard/inventory',
        });

      // 5b. Send email alert to the owner if an address is available
      if (ownerEmail) {
        await sendEmail({
          to: ownerEmail,
          subject: isNegative
            ? `🚨 Sold beyond stock — ${productName} (${branchName})`
            : `⚠️ Low stock alert — ${productName} (${branchName})`,
          html: buildLowStockEmail({
            businessName: business?.name ?? 'Your business',
            productName:  `${productName} — ${branchName}`,
            quantity:     item.quantity,
            threshold:    item.low_stock_threshold,
            negative:     isNegative,
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
 * Resolve (mark read) unread stock alerts for products whose on-hand has
 * recovered at a branch. Called from the stock-in paths (transfer receive,
 * return-to-source) so booking a receipt clears the warning automatically
 * instead of leaving a stale red banner for a manager to dismiss by hand.
 * (Register A75.)
 *
 * Non-blocking and never throws — a failure here must not fail the receipt.
 */
export async function resolveStockNotifications(
  businessId: string,
  branchId: string,
  productIds: string[],
): Promise<void> {
  if (!productIds.length) return;

  try {
    const { data: levels, error } = await supabase
      .from('stock_levels')
      .select('product_id, quantity, low_stock_threshold')
      .eq('branch_id', branchId)
      .in('product_id', productIds);

    if (error) { console.error('[lowStock] resolve read failed:', error.message); return; }
    if (!levels?.length) return;

    const now = new Date().toISOString();

    for (const level of levels) {
      const marker = stockAlertMarker(level.product_id, branchId);

      // Only clear the alert types the recovered level actually satisfies —
      // shouldResolveStockAlert keeps the "cleared" rule in one tested place.
      // A partial receipt that lifts stock above 0 but still below the low
      // threshold correctly clears negative_stock and leaves low_stock standing.
      const clearable = (['negative_stock', 'low_stock'] as StockAlertType[])
        .filter(t => shouldResolveStockAlert(t, level.quantity, level.low_stock_threshold));

      if (!clearable.length) continue;

      await supabase
        .from('notifications')
        .update({ read_at: now })
        .eq('business_id', businessId)
        .in('type', clearable)
        .ilike('message', `%${marker}%`)
        .is('read_at', null);
    }
  } catch (err: any) {
    console.error('[lowStockChecker] resolveStockNotifications error:', err.message);
  }
}

/**
 * Check ingredient stock levels after a sale deduction.
 * Fires a low_stock notification for any ingredient below its reorder_level.
 * Called from POST /api/orders — non-blocking, never throws.
 */
export async function checkLowIngredients(
  businessId: string,
  branchId: string,
  ingredientIds: string[],
): Promise<void> {
  if (!ingredientIds.length) return;

  try {
    // Per-branch stock + reorder level, joined to the ingredient catalogue name.
    const { data: rows } = await supabase
      .from('ingredient_stock_levels')
      .select('ingredient_id, current_stock, reorder_level, ingredients ( name )')
      .eq('business_id', businessId)
      .eq('branch_id', branchId)
      .in('ingredient_id', ingredientIds)
      .gt('reorder_level', 0); // only those with a reorder level set for this branch

    if (!rows?.length) return;

    const lowItems = rows.filter((r: any) => Number(r.current_stock) <= Number(r.reorder_level));
    if (!lowItems.length) return;

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, owner_id')
      .eq('id', businessId)
      .single();

    const { data: branch } = await supabase
      .from('branches').select('name').eq('id', branchId).maybeSingle();
    const branchName = branch?.name ?? 'branch';

    let ownerEmail: string | null = null;
    if (business?.owner_id) {
      const { data: { user } } = await supabase.auth.admin.getUserById(business.owner_id);
      ownerEmail = user?.email ?? null;
    }

    for (const item of lowItems as any[]) {
      const name    = item.ingredients?.name ?? 'Unknown ingredient';
      const current = Number(item.current_stock);
      const reorder = Number(item.reorder_level);

      // Dedupe per ingredient+branch: skip if an unread alert already exists.
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('business_id', businessId)
        .eq('type', 'low_stock')
        .ilike('message', `%${item.ingredient_id}|${branchId}%`)
        .is('read_at', null)
        .maybeSingle();

      if (existing) continue;

      const isOut = current <= 0;
      const title = isOut
        ? `Out of stock: ${name} (${branchName})`
        : `Low ingredient: ${name} (${branchName})`;
      const message = isOut
        ? `${name} [${item.ingredient_id}|${branchId}] is out of stock at ${branchName}. Reorder level: ${reorder}.`
        : `${name} [${item.ingredient_id}|${branchId}] is at ${current} at ${branchName} (reorder level: ${reorder}).`;

      await supabase.from('notifications').insert({
        business_id: businessId,
        branch_id:   branchId,
        user_id:     business?.owner_id ?? null,
        type:        'low_stock',
        title,
        message,
        link:        '/dashboard/stock/ingredients',
      });

      if (ownerEmail) {
        await sendEmail({
          to:      ownerEmail,
          subject: `⚠️ ${isOut ? 'Out of stock' : 'Low ingredient'} — ${name} (${branchName})`,
          html:    buildLowIngredientEmail({
            businessName:   business?.name ?? 'Your business',
            ingredientName: `${name} — ${branchName}`,
            currentStock:   current,
            reorderLevel:   reorder,
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
  negative?: boolean;
}): string {
  const neg = opts.negative === true;
  const heading  = neg ? 'Sold beyond stock' : 'Low stock alert';
  const subhead  = neg
    ? 'This item sold past its recorded stock. If a transfer arrived, receive it to clear this.'
    : 'Action may be needed to avoid running out.';
  const emoji    = neg ? '🚨' : '⚠️';
  const numColor = neg ? '#ef4444' : '#f97316';
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
              <p style="margin:0 0 8px;font-size:28px;">${emoji}</p>
              <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#ffffff;">${heading}</h1>
              <p style="margin:0 0 24px;font-size:14px;color:#9ca3af;">${subhead}</p>

              <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:24px;">
                <tr>
                  <td>
                    <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#ffffff;">${opts.productName}</p>
                    <p style="margin:0;font-size:13px;color:#6b7280;">Current stock</p>
                  </td>
                  <td align="right">
                    <p style="margin:0;font-size:24px;font-weight:700;color:${numColor};">${opts.quantity}</p>
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
