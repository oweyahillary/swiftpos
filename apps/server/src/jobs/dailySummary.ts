import { meterJob } from '../lib/supabaseMeter';   // A591: this job's Supabase calls, counted
import cron from 'node-cron';
import { receivesBranchReports } from './ownerAlertsData';   // A490
import { supabase } from '../lib/supabase';
import { chunkIn, pageAll } from '../lib/pgQuery';
import { sendEmail } from '../lib/mailer';
// P1-7: formatInTimeZone CONVERTS to Nairobi's clock. date-fns-tz's `format(…, { timeZone })` does not (it formats the
// machine's own time — UTC on Render), so the 21:00 send decision ran at 00:00 Nairobi and reported "No sales recorded today".
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { decideDailySend } from './reportScheduleDecision';
import { businessDateEAT, businessRangeEAT } from '@zaptill/core/businessDay';   // 0.6.34
import { getDayCutoff } from '../lib/dayCutoff';
import { readAlerts } from './ownerAlertsDecision';     // A476: what the owner chose the email includes
import { dailyExtrasHtml } from './ownerAlertsData';    // A476: open tills, cash differences, voids, tills, expenses
import { esc } from './ownerEmails';
import { creditCounts, creditEmailBlock, listCreditSales, type CreditListRow } from '../lib/creditConfirm';   // A545
import { lossEmailHtml } from './lossAlerts';   // A576

/**
 * A476: the owner also chooses what it includes (Settings › Report Scheduler › "What the daily email includes"): tills
 * not closed or confirmed, cash differences at confirm, voids and refunds, tills not syncing, expenses, low stock.
 *
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

  cron.schedule(schedule, meterJob('dailySummary', async () => {
    try {
      await runDailySummary();
    } catch (err: any) {
      console.error('[dailySummary] Job failed:', err.message);
    }
  }), { timezone: 'UTC' });

  console.log(`[dailySummary] Scheduled: ${schedule} (per-business send_time honoured)`);
}

export async function runDailySummary(now: Date = new Date()): Promise<void> {   // A476: exported (and `now`) for the tests
  // Date range: midnight-to-midnight in East Africa Time (UTC+3).
  // date-fns-tz handles DST-safe conversions — no manual hour arithmetic needed.
  const EAT = 'Africa/Nairobi';

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
  const nowEatDate = formatInTimeZone(now, EAT, 'yyyy-MM-dd');
  const nowEatHHMM = formatInTimeZone(now, EAT, 'HH:mm');

  // A593: every business's schedule and last-sent stamp in ONE read (it was one or two reads per business every 15 min).
  // A duplicate key, or the read failing: that business read on its own, as before.
  const pre = await readSettingsFor((businesses as Array<{ id: string }>).map((b) => b.id), ['report_schedule', 'report_schedule_last_sent']);
  const one = (bizId: string, key: string): { value: unknown } | null | undefined => {
    if (!pre) return undefined;
    const rows = pre.get(`${bizId}|${key}`) ?? [];
    return rows.length > 1 ? undefined : (rows[0] ?? null);
  };
  for (const biz of businesses) {
    try {
      // A54: the report goes out only if this business enabled it, only at/after
      // its own send_time, and only once per EAT day.
      const pre1 = one(biz.id, 'report_schedule');
      const schedule = pre1 === undefined ? await readReportSchedule(biz.id) : parseReportSchedule(pre1);
      // A591: a business with the report off is decided without its last-sent stamp (decideDailySend refuses a schedule
      // that is off first) — one Supabase call per business every 15 minutes instead of two.
      // A595 (owner, 2026-10-27, decision D3: "the emails must go out automatically once a recipient is set"): an address
      // in the scheduler sends the daily report, whether or not its switch was turned on.
      const sends = !!schedule?.enabled || (schedule?.recipients?.length ?? 0) > 0;
      if (!sends) continue;
      const pre2 = one(biz.id, 'report_schedule_last_sent');
      const lastSent = pre2 === undefined ? await readLastSent(biz.id) : lastSentOf(pre2);
      if (!decideDailySend({ ...schedule, enabled: true }, nowEatDate, nowEatHHMM, lastSent)) continue;

      const recipients = await gatherRecipients(biz, schedule);
      if (recipients.length === 0) {
        console.warn(`[dailySummary] ${biz.name} (${biz.id}): enabled but no recipients — skipping.`);
        continue;
      }

      // 0.6.34: the business's own day (its "Business day ends at" cut-off) — with the default 00:00 this is exactly
      // dateFrom..dateTo above; with 04:00 a bar's night counts to the evening it started.
      const cutoff = await getDayCutoff(biz.id);
      const range = cutoff ? businessRangeEAT(businessDateEAT(now, cutoff), businessDateEAT(now, cutoff), cutoff)
                           : { start: dateFrom, end: dateTo };
      await sendSummaryForBusiness(biz, range.start, range.end, recipients, now);
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


/**
 * A593: business_settings rows of MANY businesses for a few keys in one read per 150 businesses × keys (the jobs read
 * one row per business per key every 15 minutes). `${business_id}|${key}` → the rows found (more than one = a duplicate
 * key, which the single read refuses — the caller then reads that one as before). null when the read failed (the caller
 * reads each as before).
 */
export type SettingsRows = Map<string, Array<{ id: string; value: unknown }>>;
export async function readSettingsFor(businessIds: string[], keys: string[]): Promise<SettingsRows | null> {
  const out: SettingsRows = new Map();
  try {
    for (let k = 0; k < keys.length; k += 100) {
      const ks = keys.slice(k, k + 100);
      for (let i = 0; i < businessIds.length; i += 150) {
        const rows = await pageAll<{ id: string; business_id: string; key: string; value: unknown }>(() => supabase
          .from('business_settings').select('id, business_id, key, value')
          .in('business_id', businessIds.slice(i, i + 150)).in('key', ks), 1000);
        for (const r of rows) {
          const kk = `${r.business_id}|${r.key}`;
          out.set(kk, [...(out.get(kk) ?? []), { id: r.id, value: r.value }]);
        }
      }
    }
    return out;
  } catch { return null; }
}

const DEFAULT_SCHEDULE = { enabled: false, send_time: '21:00', recipients: [] as string[] };
/** The schedule as readReportSchedule answers it, from the row's value (null: no row). */
export function parseReportSchedule(data: { value: unknown } | null): { enabled: boolean; send_time: string; recipients: string[] } {
  const DEFAULT = { ...DEFAULT_SCHEDULE, recipients: [] as string[] };
  if (!data) return DEFAULT;
  try {
    const p = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    return { ...DEFAULT, ...(p && typeof p === 'object' ? p : {}) };
  } catch { return DEFAULT; }
}

export async function readReportSchedule(
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

/** A593: readLastSent's answer from the row (null: no row). */
function lastSentOf(data: { value: unknown } | null): string | null {
  if (!data?.value) return null;
  return typeof data.value === 'string' ? data.value.replace(/"/g, '') : String(data.value);
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

/** Owner + active staff holding reports.overview (with an email; A490 — was the role name branch_manager) + the
 *  scheduler's added addresses, deduped. */
export async function gatherRecipients(
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

  // Active staff who hold reports.overview and have an email on file (A490: receivesBranchReports).
  const { data: staff } = await supabase
    .from('users').select('email, roles ( name, role_permissions ( permissions ( key ) ) ), user_permissions ( granted, permissions ( key ) )')
    .eq('business_id', biz.id).eq('status', 'active').not('email', 'is', null);
  for (const u of staff ?? []) {
    if (receivesBranchReports(u as any)) {
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
  now: Date = new Date(),
): Promise<void> {
  // Recipients (owner + branch managers + added addresses) are resolved and
  // de-duped by gatherRecipients before this is called; an empty set never
  // reaches here.

  const currency = biz.currency ?? 'KES';

  // A476: the owner's switches, and the business day being reported (the same cut-off the range came from).
  const settings = readAlerts(await readReportSchedule(biz.id));
  const dayCutoff = await getDayCutoff(biz.id);
  const extrasHtml = await dailyExtrasHtml({
    businessId: biz.id, currency, settings, reportDate: businessDateEAT(now, dayCutoff), cutoff: dayCutoff,
    range: { start: dateFrom, end: dateTo }, now,
  });

  // ── 1. Sales summary ──────────────────────────────────────
  // P2-16: paged. One plain read stopped at the row cap (1000) and a busy day's email under-reported its sales silently.
  // A failed read throws: this business's email is retried on the next run, never sent with wrong figures.
  const orders = await pageAll<{ id: string; total: number | string; vat_amount: number | string; status: string; cashier_id: string | null }>(
    () => supabase
      .from('orders')
      .select('id, total, vat_amount, status, cashier_id')
      .eq('business_id', biz.id)
      .eq('status', 'completed')
      .gte('created_at', dateFrom)
      .lt('created_at', dateTo));

  // P0-2 (migration 133): offline till sales the cloud priced differently — kept at the till's price, the difference a
  // loss. A line in the email only when there are any; before migration 133 there are none to read.
  const priceDiffs = await offlinePriceDifferences(biz.id, dateFrom, dateTo);

  // A545: credit sales still waiting for a manager's confirmation, and the disputed ones listed for the owner. Never
  // blocks anything (the day closes regardless); '' when there are none — and before migration 157.
  const creditHtml = await creditSummaryHtml(biz.id, currency);

  // A576: the day's loss-prevention alerts (worth a look, at most 10, none about a person this email goes to). '' when
  // switched off, none, or before migration 166 — never blocks the email.
  const lossHtml = await lossEmailHtml(biz, recipients, now);

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
      // There is no `staff` table — staff are rows in `users`, and the
      // column is `name`, not `full_name`. This query has never returned a row,
      // so the daily summary's staff-performance section has always been empty.
      const staffMembers = await chunkIn<{ id: string; name: string | null }>('users', 'id', staffIds, q => q.select('id, name'));

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

  if (branchIds.length && settings.low_stock) {
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
    // Paged (P2-16): a business with many products across branches passes the row cap.
    let levels: Array<{ product_id: string; quantity: number | string; low_stock_threshold: number | string }> = [];
    try {
      levels = await pageAll(() => supabase
        .from('stock_levels')
        .select('id, product_id, quantity, low_stock_threshold')
        .in('branch_id', branchIds));
    } catch (lvlErr: any) { console.error('[dailySummary] stock level read failed:', lvlErr?.message); }

    // Number() on both sides (audit C7): numeric arrives as a string and
    // "9" < "10" is false.
    const lowLevels = (levels ?? []).filter(
      l => Number(l.quantity) < Number(l.low_stock_threshold));

    if (lowLevels.length) {
      const products = await chunkIn<{ id: string; name: string }>('products', 'id', [...new Set(lowLevels.map(l => l.product_id))],
        q => q.select('id, name'));

      const productMap = new Map(products.map(p => [p.id, p.name]));
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
  const todayLabel = formatInTimeZone(now, EAT, 'EEEE, d MMMM');
  const todayShort = formatInTimeZone(now, EAT, 'd MMM');
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
      showLowStock: settings.low_stock,
      showTopProducts: settings.top_products,
      extrasHtml: `${extrasHtml ?? ''}${creditHtml}${lossHtml}`,   // A545 · A576
      priceDiffs,
    }),
    // TODO (Step 19/21): pass fromOverride from business_settings 'notify_from_email'
    // e.g. from: `${biz.name} <reports@${biz.domain}>`
  });

  console.log(`[dailySummary] Sent for ${biz.name} → ${recipients.length} recipient(s)`);
}

/**
 * P0-2 (migration 133): the day's offline till sales the cloud priced differently (dated by when they were sold) — how
 * many, the loss (catalogue - till, summed), and how many were flagged (a difference over half the price). Zero when the
 * table is not there yet or cannot be read: the line is left out, the email still goes.
 */
export async function offlinePriceDifferences(businessId: string, dateFrom: string, dateTo: string):
  Promise<{ count: number; loss: number; suspicious: number }> {
  try {
    const rows = await pageAll<{ id: string; difference: number | string; suspicious: boolean | null }>(() => supabase
      .from('order_price_variances').select('id, difference, suspicious')
      .eq('business_id', businessId).gte('sold_at', dateFrom).lt('sold_at', dateTo));
    return {
      count: rows.length,
      loss: Math.round(rows.reduce((s, r) => s + (Number(r.difference) || 0), 0) * 100) / 100,
      suspicious: rows.filter((r) => r.suspicious === true).length,
    };
  } catch (e: any) {
    console.warn(`[dailySummary] price differences not read for ${businessId} (is migration 133 applied?):`, e?.message);
    return { count: 0, loss: 0, suspicious: 0 };
  }
}

/** A545: the e-mail's credit block (lib/creditConfirm.ts) — '' when nothing waits and nothing is disputed, or on any error. */
export async function creditSummaryHtml(businessId: string, currency: string): Promise<string> {
  try {
    const counts = await creditCounts(businessId, null);
    const disputed: CreditListRow[] = counts.disputed ? await listCreditSales(businessId, null, ['disputed'], 20) : [];
    return creditEmailBlock(counts, disputed, currency);
  } catch (e: any) {
    console.warn(`[dailySummary] credit confirmations not read for ${businessId}:`, e?.message);
    return '';
  }
}

/** The email's line for offline sales priced differently; '' when there are none. */
export function priceDiffLine(d: { count: number; loss: number; suspicious: number } | undefined, currency: string): string {
  if (!d || d.count <= 0) return '';
  const c = esc(currency);
  return `
  <tr><td style="padding-top:20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid ${d.suspicious ? '#7f1d1d' : '#222'};border-radius:8px;">
      <tr><td style="padding:14px 18px;font-size:13px;color:#fff;">
        Offline sales priced differently: <strong>${d.count}</strong>, loss <strong style="color:#f97316;">${c} ${fmt(d.loss)}</strong>
        ${d.suspicious ? `<span style="color:#ef4444;font-weight:700;"> · ${d.suspicious} over half the price — check them</span>` : ''}
        <p style="margin:6px 0 0;font-size:11px;color:#6b7280;">Sold on a POS while offline at the POS's price; the menu price had changed when they reached the cloud. Reports › Voids &amp; Exceptions lists them.</p>
      </td></tr>
    </table>
  </td></tr>`;
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
  /** A476: the owner's switches (default on) and the new sections, already built (ownerEmails.ts) */
  showLowStock?: boolean;
  showTopProducts?: boolean;
  extrasHtml?: string;
  /** P0-2: offline sales priced differently (the line shows only when count > 0). */
  priceDiffs?: { count: number; loss: number; suspicious: number };
}): string {
  const showLowStock = opts.showLowStock !== false;
  const showTopProducts = opts.showTopProducts !== false;
  const biz = esc(opts.businessName);
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
          <td style="padding:10px 8px;font-size:13px;color:#fff;">${esc(p.name)}</td>
          <td style="padding:10px 0;font-size:13px;color:#9ca3af;text-align:center;">${p.qty}</td>
          <td style="padding:10px 0;font-size:13px;color:#22c55e;text-align:right;font-weight:600;">${c} ${fmt(p.revenue)}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="padding:16px 0;font-size:13px;color:#6b7280;">No sales recorded today.</td></tr>`;

  const staffRowsHtml = opts.staffRows.length
    ? opts.staffRows.map(s => `
        <tr style="border-bottom:1px solid #1a1a1a;">
          <td style="padding:10px 0;font-size:13px;color:#fff;">${esc(s.name)}</td>
          <td style="padding:10px 0;font-size:13px;color:#9ca3af;text-align:center;">${s.orders}</td>
          <td style="padding:10px 0;font-size:13px;color:#22c55e;text-align:right;font-weight:600;">${c} ${fmt(s.revenue)}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:16px 0;font-size:13px;color:#6b7280;">No staff data available.</td></tr>`;

  const lowStockRowsHtml = opts.lowStockItems.length
    ? opts.lowStockItems.map(item => `
        <tr style="border-bottom:1px solid #1a1a1a;">
          <td style="padding:10px 0;font-size:13px;color:#fff;">${esc(item.name)}</td>
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
    <p style="margin:0;font-size:22px;font-weight:700;color:#22c55e;">ZapTill</p>
    <p style="margin:4px 0 0;font-size:12px;color:#6b7280;">${biz} · Daily Report</p>
  </td></tr>

  <!-- Date banner -->
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
    <p style="margin:0;font-size:16px;font-weight:600;color:#fff;">📊 ${date}</p>
    <p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Here's how ${biz} performed today.</p>
  </td></tr>

  <!-- Stat cards -->
  <tr><td style="padding-top:24px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${statCard('Orders', String(opts.totalOrders), opts.voidedCount ? `${opts.voidedCount} voided` : undefined)}
        ${statCard('Revenue', `${c} ${fmt(opts.totalRevenue)}`)}
        ${statCard('VAT Collected', `${c} ${fmt(opts.totalVat)}`)}
        ${showLowStock ? statCard('Low Stock', String(opts.lowStockItems.length), opts.lowStockItems.length ? 'needs attention' : 'all good') : ''}
      </tr>
    </table>
  </td></tr>

  <!-- P0-2: offline sales priced differently (only when there are any) -->
  ${priceDiffLine(opts.priceDiffs, c)}

  <!-- A476: points of sale not closed or confirmed, cash differences, voids and refunds, points of sale not syncing, expenses -->
  ${opts.extrasHtml ?? ''}

  <!-- Top products -->
  ${showTopProducts ? `${sectionHeader('Top Products')}
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
  </td></tr>` : ''}

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
  ${showLowStock ? `${sectionHeader('Inventory Alert')}
  <tr><td style="background:#111;border:1px solid #1a1a1a;border-radius:12px;padding:4px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr style="border-bottom:1px solid #222;">
        <td style="padding:10px 0;font-size:11px;color:#4b5563;">PRODUCT</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:center;">IN STOCK</td>
        <td style="padding:10px 0;font-size:11px;color:#4b5563;text-align:right;">THRESHOLD</td>
      </tr>
      ${lowStockRowsHtml}
    </table>
  </td></tr>` : ''}

  <!-- CTA -->
  <tr><td style="padding-top:28px;text-align:center;">
    <a href="${process.env.DASHBOARD_URL ?? 'https://app.zaptill.co.ke'}/dashboard/reports"
       style="display:inline-block;background:#22c55e;color:#000;font-weight:700;font-size:14px;padding:14px 32px;border-radius:8px;text-decoration:none;">
      View full reports →
    </a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding-top:32px;text-align:center;">
    <p style="margin:0;font-size:11px;color:#374151;">
      Sent by ZapTill · ${biz} · Choose what this email includes in Settings › Report Scheduler.
      <!-- TODO (Step 19/21): Replace with per-business domain sender -->
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
