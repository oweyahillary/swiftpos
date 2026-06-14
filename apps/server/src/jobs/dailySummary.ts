import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { sendEmail } from '../lib/mailer';
import { toZonedTime, fromZonedTime, format as tzFormat } from 'date-fns-tz';

/**
 * Daily summary job — runs at 9:00 PM EAT (18:00 UTC) every day.
 * Sends a full HTML report to each business owner covering:
 *   - Today's sales total + order count + VAT collected
 *   - Top 5 products by revenue
 *   - Staff performance (orders per staff member)
 *   - All products currently below low_stock_threshold
 *
 * Per-business domain sending: currently uses platform FROM address.
 * TODO (Step 19/21): read 'notify_from_email' from business_settings and
 *   pass as fromOverride to sendEmail() so each business sends from their domain.
 */
export function startDailySummaryJob(): void {
  // 0 18 * * * = 18:00 UTC = 21:00 EAT (UTC+3)
  const schedule = process.env.DAILY_SUMMARY_CRON ?? '0 18 * * *';

  cron.schedule(schedule, async () => {
    console.log('[dailySummary] Running daily summary job…');
    try {
      await runDailySummary();
    } catch (err: any) {
      console.error('[dailySummary] Job failed:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log(`[dailySummary] Scheduled: ${schedule} UTC`);
}

async function runDailySummary(): Promise<void> {
  // Date range: midnight-to-midnight in East Africa Time (UTC+3).
  // date-fns-tz handles DST-safe conversions — no manual hour arithmetic needed.
  const EAT = 'Africa/Nairobi';
  const now = new Date();

  // Start of today in EAT, converted back to UTC for Supabase queries
  const todayStartEAT = toZonedTime(now, EAT);
  todayStartEAT.setHours(0, 0, 0, 0);
  const todayEndEAT = new Date(todayStartEAT);
  todayEndEAT.setHours(23, 59, 59, 999);

  const dateFrom = fromZonedTime(todayStartEAT, EAT).toISOString();
  const dateTo   = fromZonedTime(todayEndEAT, EAT).toISOString();

  // Fetch all active businesses
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, name, owner_id, currency');

  if (!businesses?.length) return;

  for (const biz of businesses) {
    try {
      await sendSummaryForBusiness(biz, dateFrom, dateTo);
    } catch (err: any) {
      console.error(`[dailySummary] Failed for business ${biz.id}:`, err.message);
    }
  }
}

async function sendSummaryForBusiness(
  biz: { id: string; name: string; owner_id: string; currency: string },
  dateFrom: string,
  dateTo: string,
): Promise<void> {
  // Get owner email
  const { data: { user } } = await supabase.auth.admin.getUserById(biz.owner_id);
  const ownerEmail = user?.email;
  if (!ownerEmail) return;

  const currency = biz.currency ?? 'KES';

  // ── 1. Sales summary ──────────────────────────────────────
  const { data: orders } = await supabase
    .from('orders')
    .select('id, total, vat_amount, status, created_by')
    .eq('business_id', biz.id)
    .eq('status', 'completed')
    .gte('created_at', dateFrom)
    .lt('created_at', dateTo);

  const totalOrders  = orders?.length ?? 0;
  const totalRevenue = (orders ?? []).reduce((s, o) => s + Number(o.total), 0);
  const totalVat     = (orders ?? []).reduce((s, o) => s + Number(o.vat_amount), 0);
  const voidedCount  = orders?.filter(o => o.status === 'voided').length ?? 0;

  // ── 2. Top 5 products by revenue ─────────────────────────
  const orderIds = (orders ?? []).map(o => o.id);
  let topProducts: { name: string; revenue: number; qty: number }[] = [];

  if (orderIds.length) {
    const { data: items } = await supabase
      .from('order_items')
      .select('product_name, quantity, subtotal')
      .in('order_id', orderIds);

    const productTotals = new Map<string, { revenue: number; qty: number }>();
    for (const item of items ?? []) {
      const existing = productTotals.get(item.product_name) ?? { revenue: 0, qty: 0 };
      productTotals.set(item.product_name, {
        revenue: existing.revenue + Number(item.subtotal),
        qty: existing.qty + item.quantity,
      });
    }
    topProducts = [...productTotals.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }

  // ── 3. Staff performance ──────────────────────────────────
  let staffRows: { name: string; orders: number; revenue: number }[] = [];
  if (orderIds.length) {
    const staffTotals = new Map<string, { orders: number; revenue: number }>();
    for (const o of orders ?? []) {
      if (!o.created_by) continue;
      const existing = staffTotals.get(o.created_by) ?? { orders: 0, revenue: 0 };
      staffTotals.set(o.created_by, {
        orders: existing.orders + 1,
        revenue: existing.revenue + Number(o.total),
      });
    }

    if (staffTotals.size) {
      const staffIds = [...staffTotals.keys()];
      const { data: staffMembers } = await supabase
        .from('staff')
        .select('id, full_name')
        .in('id', staffIds);

      staffRows = (staffMembers ?? []).map(s => ({
        name: s.full_name ?? 'Unknown',
        ...(staffTotals.get(s.id) ?? { orders: 0, revenue: 0 }),
      })).sort((a, b) => b.revenue - a.revenue);
    }
  }

  // ── 4. Low stock items ────────────────────────────────────
  const { data: branches } = await supabase
    .from('branches')
    .select('id')
    .eq('business_id', biz.id);

  const branchIds = (branches ?? []).map(b => b.id);
  let lowStockItems: { name: string; quantity: number; threshold: number }[] = [];

  if (branchIds.length) {
    const { data: levels } = await supabase
      .from('stock')
      .select('product_id, quantity, low_stock_threshold')
      .in('branch_id', branchIds)
      .lt('quantity', supabase.rpc ? 'low_stock_threshold' : 999); // filter below

    // Manual filter since Supabase doesn't support column comparison in .lt()
    const lowLevels = (levels ?? []).filter(l => l.quantity < l.low_stock_threshold);

    if (lowLevels.length) {
      const { data: products } = await supabase
        .from('products')
        .select('id, name')
        .in('id', lowLevels.map(l => l.product_id));

      const productMap = new Map((products ?? []).map(p => [p.id, p.name]));
      lowStockItems = lowLevels.map(l => ({
        name: productMap.get(l.product_id) ?? 'Unknown',
        quantity: l.quantity,
        threshold: l.low_stock_threshold,
      }));
    }
  }

  // ── 5. Write in-app notification ──────────────────────────
  const EAT = 'Africa/Nairobi';
  const todayLabel = tzFormat(toZonedTime(new Date(), EAT), 'EEEE, d MMMM', { timeZone: EAT });
  const todayShort = tzFormat(toZonedTime(new Date(), EAT), 'd MMM', { timeZone: EAT });
  await supabase.from('notifications').insert({
    business_id: biz.id,
    user_id: biz.owner_id,
    type: 'daily_summary',
    title: `Daily summary — ${todayLabel}`,
    message: `${totalOrders} orders · ${currency} ${totalRevenue.toLocaleString()} revenue · ${lowStockItems.length} low stock item${lowStockItems.length !== 1 ? 's' : ''}`,
    link: '/dashboard/reports',
  });

  // ── 6. Send email ─────────────────────────────────────────
  await sendEmail({
    to: ownerEmail,
    subject: `📊 Daily summary — ${biz.name} · ${todayShort}`,
    html: buildSummaryEmail({
      businessName: biz.name,
      currency,
      totalOrders,
      totalRevenue,
      totalVat,
      voidedCount,
      topProducts,
      staffRows,
      lowStockItems,
      dateLabel: todayLabel,
    }),
    // TODO (Step 19/21): pass fromOverride from business_settings 'notify_from_email'
    // e.g. from: `${biz.name} <reports@${biz.domain}>`
  });

  console.log(`[dailySummary] Sent for ${biz.name} → ${ownerEmail}`);
}

// ── Email template ────────────────────────────────────────────
function fmt(n: number) { return n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function buildSummaryEmail(opts: {
  businessName: string;
  currency: string;
  totalOrders: number;
  totalRevenue: number;
  totalVat: number;
  voidedCount: number;
  topProducts: { name: string; revenue: number; qty: number }[];
  staffRows: { name: string; orders: number; revenue: number }[];
  lowStockItems: { name: string; quantity: number; threshold: number }[];
  dateLabel: string;
}): string {
  const { currency: c } = opts;
  const date = opts.dateLabel;

  const statCard = (label: string, value: string, sub?: string) => `
    <td width="25%" style="padding:0 6px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;">
        <tr><td>
          <p style="margin:0 0 4px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">${label}</p>
          <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">${value}</p>
          ${sub ? `<p style="margin:4px 0 0;font-size:11px;color:#6b7280;">${sub}</p>` : ''}
        </td></tr>
      </table>
    </td>`;

  const sectionHeader = (title: string) => `
    <tr><td style="padding:28px 0 12px;">
      <p style="margin:0;font-size:13px;font-weight:600;color:#22c55e;text-transform:uppercase;letter-spacing:0.08em;">${title}</p>
    </td></tr>`;

  const topProductsRows = opts.topProducts.length
    ? opts.topProducts.map((p, i) => `
        <tr style="border-bottom:1px solid #1a1a1a;">
          <td style="padding:10px 0;font-size:13px;color:#9ca3af;">${i + 1}</td>
          <td style="padding:10px 8px;font-size:13px;color:#fff;">${p.name}</td>
          <td style="padding:10px 0;font-size:13px;color:#9ca3af;text-align:center;">${p.qty}</td>
          <td style="padding:10px 0;font-size:13px;color:#22c55e;text-align:right;font-weight:600;">${c} ${fmt(p.revenue)}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="padding:16px 0;font-size:13px;color:#6b7280;">No sales recorded today.</td></tr>`;

  const staffRowsHtml = opts.staffRows.length
    ? opts.staffRows.map(s => `
        <tr style="border-bottom:1px solid #1a1a1a;">
          <td style="padding:10px 0;font-size:13px;color:#fff;">${s.name}</td>
          <td style="padding:10px 0;font-size:13px;color:#9ca3af;text-align:center;">${s.orders}</td>
          <td style="padding:10px 0;font-size:13px;color:#22c55e;text-align:right;font-weight:600;">${c} ${fmt(s.revenue)}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px 0;font-size:13px;color:#6b7280;">No staff data available.</td></tr>`;

  const lowStockRowsHtml = opts.lowStockItems.length
    ? opts.lowStockItems.map(item => `
        <tr style="border-bottom:1px solid #1a1a1a;">
          <td style="padding:10px 0;font-size:13px;color:#fff;">${item.name}</td>
          <td style="padding:10px 0;font-size:13px;font-weight:700;color:#f97316;text-align:center;">${item.quantity}</td>
          <td style="padding:10px 0;font-size:13px;color:#6b7280;text-align:right;">${item.threshold}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px 0;font-size:13px;color:#22c55e;">✓ All products are well stocked.</td></tr>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <!-- Header -->
  <tr><td style="padding-bottom:32px;">
    <p style="margin:0;font-size:22px;font-weight:700;color:#22c55e;">SwiftPOS</p>
    <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">${opts.businessName} · Daily Report</p>
  </td></tr>

  <!-- Date banner -->
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
    <p style="margin:0;font-size:16px;font-weight:600;color:#fff;">📊 ${date}</p>
    <p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Here's how ${opts.businessName} performed today.</p>
  </td></tr>

  <!-- Stat cards -->
  <tr><td style="padding-top:24px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${statCard('Orders', String(opts.totalOrders), opts.voidedCount ? `${opts.voidedCount} voided` : undefined)}
        ${statCard('Revenue', `${c} ${fmt(opts.totalRevenue)}`)}
        ${statCard('VAT Collected', `${c} ${fmt(opts.totalVat)}`)}
        ${statCard('Low Stock', String(opts.lowStockItems.length), opts.lowStockItems.length ? 'needs attention' : 'all good')}
      </tr>
    </table>
  </td></tr>

  <!-- Top products -->
  ${sectionHeader('Top Products')}
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:4px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr style="border-bottom:1px solid #222;">
        <td style="padding:10px 0;font-size:11px;color:#4b5563;">#</td>
        <td style="padding:10px 8px;font-size:11px;color:#4b5563;">PRODUCT</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:center;">QTY</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:right;">REVENUE</td>
      </tr>
      ${topProductsRows}
    </table>
  </td></tr>

  <!-- Staff -->
  ${sectionHeader('Staff Performance')}
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:4px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr style="border-bottom:1px solid #222;">
        <td style="padding:10px 0;font-size:11px;color:#4b5563;">STAFF MEMBER</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:center;">ORDERS</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:right;">REVENUE</td>
      </tr>
      ${staffRowsHtml}
    </table>
  </td></tr>

  <!-- Low stock -->
  ${sectionHeader('Inventory Alert')}
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:4px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr style="border-bottom:1px solid #222;">
        <td style="padding:10px 0;font-size:11px;color:#4b5563;">PRODUCT</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:center;">IN STOCK</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:right;">THRESHOLD</td>
      </tr>
      ${lowStockRowsHtml}
    </table>
  </td></tr>

  <!-- CTA -->
  <tr><td style="padding-top:28px;text-align:center;">
    <a href="${process.env.DASHBOARD_URL ?? 'https://app.swiftpos.co.ke'}/dashboard/reports"
       style="display:inline-block;background:#22c55e;color:#000;font-weight:700;font-size:14px;padding:14px 32px;border-radius:8px;text-decoration:none;">
      View full reports →
    </a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding-top:32px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#374151;">
      Sent by SwiftPOS · ${opts.businessName}
      <!-- TODO (Step 19/21): Replace with per-business domain sender -->
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
