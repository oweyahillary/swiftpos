import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { chunkIn } from '../lib/pgQuery';
import { sendEmail } from '../lib/mailer';
import { toZonedTime, fromZonedTime, format as tzFormat } from 'date-fns-tz';
import { decideDailySend } from './reportScheduleDecision';

/**
 * Daily summary job — runs every 15 min and, for each business that has enabled
 * the daily report (dashboard → Settings → Report Scheduler), sends once per day
 * at that business's own send_time, to the owner + branch managers + any extra
 * addresses on the schedule (register A54). Report covers:
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
  // Runs FREQUENTLY, not once a day, because each business now chooses its own
  // send_time (register A54). Each run decides, per business, whether "now" (EAT)
  // is at/after that business's send_time and whether today's report has already
  // gone out — so a business is emailed at most once per EAT day, near its own
  // configured minute. 15 minutes bounds how late a report can be.
  //
  // PROD NOTE: if DAILY_SUMMARY_CRON is set in the environment to a once-a-day
  // value it DEFEATS per-business send_time (only businesses due at that instant
  // are caught). Unset it, or set a frequent schedule.
  const schedule = process.env.DAILY_SUMMARY_CRON ?? '*/15 * * * *';

  cron.schedule(schedule, async () => {
    try {
      await runDailySummary();
    } catch (err: any) {
      console.error('[dailySummary] Job failed:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log(`[dailySummary] Scheduled: ${schedule} (per-business send_time honoured)`);
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

  // Current EAT wall-clock, for the per-business send decision.
  const nowEatDate = tzFormat(now, 'yyyy-MM-dd', { timeZone: EAT });
  const nowEatHHMM = tzFormat(now, 'HH:mm', { timeZone: EAT });

  for (const biz of businesses) {
    try {
      // A54: the report goes out only if this business enabled it, only at/after
      // its own send_time, and only once per EAT day.
      const schedule = await readReportSchedule(biz.id);
      const lastSent = await readLastSent(biz.id);
      if (!decideDailySend(schedule, nowEatDate, nowEatHHMM, lastSent)) continue;

      const recipients = await gatherRecipients(biz, schedule);
      if (recipients.length === 0) {
        console.warn(`[dailySummary] ${biz.name} (${biz.id}): enabled but no recipients — skipping.`);
        continue;
      }

      await sendSummaryForBusiness(biz, dateFrom, dateTo, recipients);
      // Stamp AFTER a successful send, so a failure retries on the next run
      // rather than being silently marked done.
      await writeLastSent(biz.id, nowEatDate);
    } catch (err: any) {
      console.error(`[dailySummary] Failed for ${biz.name} (${biz.id}):`, err.message);
    }
  }
}

// ── A54: per-business scheduling, recipients, and once-per-day dedup ─────────
// The send decision itself lives in ./reportScheduleDecision (pure + tested).

const normRole = (s: string) => (s || '').toLowerCase().replace(/ /g, '_');

async function readReportSchedule(
  businessId: string,
): Promise<{ enabled: boolean; send_time: string; recipients: string[] }> {
  const DEFAULT = { enabled: false, send_time: '21:00', recipients: [] as string[] };
  const { data } = await supabase
    .from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', 'report_schedule').maybeSingle();
  if (!data) return DEFAULT;
  try {
    const p = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    return { ...DEFAULT, ...(p && typeof p === 'object' ? p : {}) };
  } catch { return DEFAULT; }
}

async function readLastSent(businessId: string): Promise<string | null> {
  const { data } = await supabase
    .from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', 'report_schedule_last_sent').maybeSingle();
  if (!data?.value) return null;
  return typeof data.value === 'string' ? data.value.replace(/"/g, '') : String(data.value);
}

async function writeLastSent(businessId: string, dateStr: string): Promise<void> {
  const { data: existing } = await supabase
    .from('business_settings').select('id')
    .eq('business_id', businessId).eq('key', 'report_schedule_last_sent').maybeSingle();
  if (existing) {
    await supabase.from('business_settings')
      .update({ value: dateStr, updated_at: new Date().toISOString() }).eq('id', existing.id);
  } else {
    await supabase.from('business_settings')
      .insert({ business_id: businessId, key: 'report_schedule_last_sent', value: dateStr });
  }
}

/** Owner + active branch managers (with an email) + the scheduler's added addresses, deduped. */
async function gatherRecipients(
  biz: { id: string; owner_id: string; name: string },
  schedule: { recipients?: string[] },
): Promise<string[]> {
  const set = new Set<string>();

  // Owner. getUserById THROWS on a malformed id, so keep the UUID guard here.
  if (biz.owner_id && UUID_RE.test(biz.owner_id)) {
    const { data: ownerData, error } = await supabase.auth.admin.getUserById(biz.owner_id);
    if (!error) {
      const e = ownerData?.user?.email?.trim().toLowerCase();
      if (e) set.add(e);
    }
  }

  // Active branch managers who have an email on file.
  const { data: staff } = await supabase
    .from('users').select('email, roles ( name )')
    .eq('business_id', biz.id).eq('status', 'active').not('email', 'is', null);
  for (const u of staff ?? []) {
    if (normRole((u as any).roles?.name) === 'branch_manager') {
      const e = String((u as any).email ?? '').trim().toLowerCase();
      if (e) set.add(e);
    }
  }

  // The addresses the owner typed into the scheduler.
  for (const r of schedule.recipients ?? []) {
    const e = String(r).trim().toLowerCase();
    if (e) set.add(e);
  }

  return [...set];
}

/**
 * `supabase.auth.admin.getUserById` THROWS on a malformed id rather than
 * returning an error in the response — "@supabase/auth-js: Expected parameter to
 * be UUID but is not". That aborted the whole summary for the affected business.
 * Observed live 31 Jul 2026 on business 395e8a31-82ec-4e29-8d64-48ad8266dd59.
 *
 * lowStockChecker.ts already guarded this with `if (business?.owner_id)`; this
 * job never did. A null guard alone is not quite enough either — an empty string
 * or a truncated id is truthy-adjacent and still throws — so check the shape.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sendSummaryForBusiness(
  biz: { id: string; name: string; owner_id: string; currency: string },
  dateFrom: string,
  dateTo: string,
  recipients: string[],
): Promise<void> {
  // Recipients (owner + branch managers + added addresses) are resolved and
  // de-duped by gatherRecipients before this is called; an empty set never
  // reaches here.

  const currency = biz.currency ?? 'KES';

  // ── 1. Sales summary ──────────────────────────────────────
  const { data: orders } = await supabase
    .from('orders')
    .select('id, total, vat_amount, status, cashier_id')
    .eq('business_id', biz.id)
    .eq('status', 'completed')
    .gte('created_at', dateFrom)
    .lt('created_at', dateTo);

  const totalOrders  = orders?.length ?? 0;
  const totalRevenue = (orders ?? []).reduce((s, o) => s + Number(o.total), 0);
  const totalVat     = (orders ?? []).reduce((s, o) => s + Number(o.vat_amount), 0);
  // voidedCount was: orders?.filter(o => o.status === 'voided').length
  // but the query above filters .eq('status','completed'), so nothing in
  // `orders` can ever be 'voided'. It has reported 0 since the day it was
  // written — and a void count is one of the few numbers an owner actually
  // reads this email for. Counted with its own query instead.
  const { count: voidedCount } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', biz.id)
    .eq('status', 'voided')
    .gte('created_at', dateFrom)
    .lt('created_at', dateTo);

  // ── 2. Top 5 products by revenue ─────────────────────────
  const orderIds = (orders ?? []).map(o => o.id);
  let topProducts: { name: string; revenue: number; qty: number }[] = [];

  if (orderIds.length) {
    const items = await chunkIn<{ product_name: string; quantity: string; subtotal: string }>(
      'order_items', 'order_id', orderIds, q => q.select('product_name, quantity, subtotal'));

    const productTotals = new Map<string, { revenue: number; qty: number }>();
    for (const item of items ?? []) {
      const existing = productTotals.get(item.product_name) ?? { revenue: 0, qty: 0 };
      productTotals.set(item.product_name, {
        revenue: existing.revenue + Number(item.subtotal),
        // Number(), like subtotal beside it. order_items.quantity is
        // numeric(12,2), and PostgREST returns numeric as a JSON STRING — so
        // this was 0 + "2.00" = "02.00", then "02.00" + "1.00" = "02.001.00".
        // The owner's Top-5 Products email has shown a growing concatenated
        // string ever since. Same class as the total_spent bug already fixed in
        // orders.ts; this one was missed because nothing typed the row.
        qty: existing.qty + Number(item.quantity),
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
      if (!o.cashier_id) continue;
      const existing = staffTotals.get(o.cashier_id) ?? { orders: 0, revenue: 0 };
      staffTotals.set(o.cashier_id, {
        orders: existing.orders + 1,
        revenue: existing.revenue + Number(o.total),
      });
    }

    if (staffTotals.size) {
      const staffIds = [...staffTotals.keys()];
      const { data: staffMembers } = await supabase
        // There is no `staff` table — staff are rows in `users`, and the
        // column is `name`, not `full_name`. This query has never returned a row,
        // so the daily summary's staff-performance section has always been empty.
        .from('users')
        .select('id, name')
        .in('id', staffIds);

      staffRows = (staffMembers ?? []).map(s => ({
        name: s.name ?? 'Unknown',
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
    // stock_levels, not stock (audit B6) — see lib/lowStockChecker.ts for the
    // full reasoning. `stock` is the table nothing writes.
    //
    // The .lt() that used to be here was three bugs in one line:
    //
    //     .lt('quantity', supabase.rpc ? 'low_stock_threshold' : 999)
    //
    //   1. `supabase.rpc` is a FUNCTION, so always truthy. The ternary always
    //      took the first branch and the 999 was unreachable.
    //   2. It therefore compared a numeric column to the literal STRING
    //      'low_stock_threshold'. PostgREST cannot cast that and rejects the
    //      request — PostgREST has no column-to-column comparison.
    //   3. `const { data: levels }` never destructured `error`, so that
    //      rejection was swallowed and `levels` was simply undefined.
    //
    // The manual filter below was always doing the real work, so the .lt() was
    // dead weight that broke the query it sat in. Removed; the filter stays.
    const { data: levels, error: lvlErr } = await supabase
      .from('stock_levels')
      .select('product_id, quantity, low_stock_threshold')
      .in('branch_id', branchIds);

    if (lvlErr) console.error('[dailySummary] stock level read failed:', lvlErr.message);

    // Number() on both sides (audit C7): numeric arrives as a string and
    // "9" < "10" is false.
    const lowLevels = (levels ?? []).filter(
      l => Number(l.quantity) < Number(l.low_stock_threshold));

    if (lowLevels.length) {
      const { data: products } = await supabase
        .from('products')
        .select('id, name')
        .in('id', lowLevels.map(l => l.product_id));

      const productMap = new Map((products ?? []).map(p => [p.id, p.name]));
      lowStockItems = lowLevels.map(l => ({
        name: productMap.get(l.product_id) ?? 'Unknown',
        // Typed `number` on lowStockItems, so coerce here or the template
        // renders "8.00" beside a threshold of "10.00" and any arithmetic
        // downstream concatenates.
        quantity: Number(l.quantity),
        threshold: Number(l.low_stock_threshold),
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
    to: recipients.join(', '),
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

  console.log(`[dailySummary] Sent for ${biz.name} → ${recipients.length} recipient(s)`);
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
