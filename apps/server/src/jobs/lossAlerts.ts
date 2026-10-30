/**
 * lossAlerts.ts (job) — A576: loss-prevention alerts, worked out every hour per business (and again just before the
 * owner's daily email), stored in public.loss_alerts (migration 166) for the dashboard's Watch list, and told ONCE to the
 * owner and the managers in the dashboard's notifications (the bell). The rules are lib/lossAlertRules.ts (pure).
 *
 * Owner, 2026-10-23: a warning only, for investigation — never an accusation; at most 10; to the owner and managers, never
 * on the cashier's screen (the till has no notifications and the person an alert is about is never told of it).
 *
 * Idempotent: an alert is one row per (business, alert_key) — run again, the same alert is updated (the count grows during
 * the day), never doubled; notified_at is set once, after its notifications are written; a dismissed alert stays
 * dismissed. One business failing never stops the others. Before migration 166 the table is missing: the job logs it once
 * per run and does nothing else.
 *
 * Reads (each bounded to the last 7 business days, only the columns used, paged): shifts (who worked, and the counted cash
 * at confirm), voided orders and their payments, refunded orders, completed orders with a discount, closed business days,
 * order_price_variances, kitchen_voids, voided parking sessions (car parks only), the users and the partners list.
 */
import { meterJob } from '../lib/supabaseMeter';   // A591: this job's Supabase calls, counted
import { writeGen, memoEnabled } from '../lib/writeActivity';   // A591
import { traffic } from '../lib/trafficStats';   // A591
import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { chunkIn, pageAll } from '../lib/pgQuery';
import { getDayCutoff } from '../lib/dayCutoff';
import { businessDateEAT, businessRangeEAT } from '@zaptill/core/businessDay';
import { keysForRow } from '../lib/effectiveKeys';
import { hasPermission } from '@zaptill/core/permissions';
import { isOwnerRoleName } from '../lib/ownerRole';
import { readPartners } from '../lib/webPartners';
import { cashDifference } from './ownerAlertsDecision';
import { lossAlertsSection } from './ownerEmails';
import { analyticsEnabled } from '../lib/analyticsAccess';   // A580: premium — the same switch as Analytics
import { ANALYTICS_FLAG } from '../lib/analyticsRules';
import {
  readLossSettings, detectLossAlerts, toNotify, teamRecipients, ownerTold, notificationTitle, lossPrevDate, kindsFor,
  emailLines, LOSS_WEEK_DAYS, type LossInput, type LossAlert, type LossSettings, type Person, type StoredAlert,
} from '../lib/lossAlertRules';

export const LOSS_SETTINGS_KEY = 'loss_alerts';
export const LOSS_NOTIFY_TYPE = 'loss_alert';            // the owner's own copy
export const LOSS_TEAM_NOTIFY_TYPE = 'loss_alert_team';  // a partner's or a manager's copy (addressed to them)

type Biz = { id: string; name: string; owner_id: string | null; currency: string | null; type?: string | null };

export function startLossAlertsJob(): void {
  const schedule = process.env.LOSS_ALERTS_CRON ?? '20 * * * *';
  // A591: quietWrites — this job writes only its own loss_alerts and notifications, which no remembered answer holds.
  cron.schedule(schedule, meterJob('lossAlerts', async () => {
    try { await runLossAlertsTick(new Date()); } catch (err: any) { console.error('[lossAlerts] Job failed:', err?.message); }
  }, { quietWrites: true }), { timezone: 'UTC' });
  console.log(`[lossAlerts] Scheduled: ${schedule} (loss-prevention alerts, the watch list)`);
}

export async function readLossSettingsFor(businessId: string): Promise<LossSettings> {
  const { data, error } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', LOSS_SETTINGS_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return readLossSettings((data as { value?: unknown } | null)?.value ?? null);
}

export async function runLossAlertsTick(now: Date = new Date()): Promise<void> {
  // A580 (owner, 2026-10-23: "Yes let them be premium"): only the businesses with premium Analytics switched on (the
  // 'analytics' feature flag) — one read for the list; every other business is skipped (nothing read, stored or told).
  const { data: flags, error: fErr } = await supabase.from('feature_flags').select('business_id')
    .eq('key', ANALYTICS_FLAG).eq('enabled', true).limit(10000);
  if (fErr) { console.error('[lossAlerts] feature_flags:', fErr.message); return; }
  const premium = [...new Set(((flags ?? []) as Array<{ business_id: string }>).map((f) => f.business_id).filter(Boolean))];
  if (premium.length === 0) return;
  let businesses: Biz[];
  try { businesses = await chunkIn<Biz>('businesses', 'id', premium, (q) => q.select('id, name, owner_id, currency, type')); }
  catch (e: any) { console.error('[lossAlerts] businesses:', e?.message); return; }
  for (const biz of businesses) {
    try {
      // A591: nothing written for the business since the last hour's run, the same business day, and nothing was left to
      // tell — the run would read the same 7 days and find the same alerts: skipped (no read). At most 6 h in a row.
      const gen = writeGen(biz.id);
      const q = lossQuiet.get(biz.id);
      if (memoEnabled() && q && q.gen === gen && now.getTime() - q.at < LOSS_QUIET_MAX_MS && businessDateEAT(now, q.cutoff) === q.today) {
        traffic.count('loss.skipped_unchanged');
        continue;
      }
      const r = await runLossAlertsForBusiness(biz, now);
      if (r.pending === 0 && r.today) lossQuiet.set(biz.id, { gen, today: r.today, cutoff: r.cutoff ?? 0, at: now.getTime() });
      else lossQuiet.delete(biz.id);
    }
    catch (e: any) { lossQuiet.delete(biz.id); console.error(`[lossAlerts] failed for ${biz.name} (${biz.id}):`, e?.message); }
  }
}

/** A591: per business, the write generation and business day of the last hourly run that left nothing to tell. */
const lossQuiet = new Map<string, { gen: string; today: string; cutoff: number; at: number }>();
export const LOSS_QUIET_MAX_MS = 6 * 3_600_000;
/** Test seam. */
export function _resetLossQuiet(): void { lossQuiet.clear(); }

const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** The rows for one business over the last 7 business days, as the rules read them. */
export async function loadLossInput(biz: Biz, now: Date, users: any[]): Promise<LossInput> {
  const cutoff = await getDayCutoff(biz.id);
  const today = businessDateEAT(now, cutoff);
  const week = Array.from({ length: LOSS_WEEK_DAYS }, (_, i) => lossPrevDate(today, LOSS_WEEK_DAYS - 1 - i));
  const { start } = businessRangeEAT(week[0], today, cutoff);
  const end = now.toISOString();
  const dateOf = (iso: string | null | undefined) => (iso ? businessDateEAT(new Date(iso), cutoff) : '');
  const inWeek = new Set(week);
  const kinds = new Set(kindsFor(biz.type));
  const id = biz.id;

  const [shiftsWorked, shiftsConfirmed, voided, refunded, discounted, days, prices, kitchen, parking, branches] = await Promise.all([
    // Who worked: shifts opened up to 2 days before the period (a drawer opened last night still counts its person today).
    pageAll<any>(() => supabase.from('shifts').select('id, branch_id, cashier_id, opened_at, closed_at')
      .eq('business_id', id).gte('opened_at', new Date(Date.parse(start) - 2 * 86_400_000).toISOString()).lte('opened_at', end)),
    pageAll<any>(() => supabase.from('shifts').select('id, branch_id, cashier_id, confirmed_at, expected_methods, confirmed_methods, cash_variance')
      .eq('business_id', id).gte('confirmed_at', start).lte('confirmed_at', end)),
    pageAll<any>(() => supabase.from('orders').select('id, branch_id, cashier_id, voided_by, voided_at, created_at, total')
      .eq('business_id', id).eq('status', 'voided').gte('voided_at', start).lte('voided_at', end)),
    pageAll<any>(() => supabase.from('orders').select('id, branch_id, cashier_id, refunded_by, refunded_at, refunded_amount')
      .eq('business_id', id).not('refunded_at', 'is', null).gte('refunded_at', start).lte('refunded_at', end)),
    pageAll<any>(() => supabase.from('orders').select('id, branch_id, cashier_id, created_at, subtotal, discount_amount, offer_discount, discount_id, total')
      .eq('business_id', id).eq('status', 'completed').gt('discount_amount', 0).gte('created_at', start).lte('created_at', end)),
    pageAll<any>(() => supabase.from('business_days').select('id, branch_id, business_date, cash_variance, status')
      .eq('business_id', id).eq('status', 'closed').gte('business_date', week[0]).lte('business_date', today)),
    pageAll<any>(() => supabase.from('order_price_variances').select('id, order_id, branch_id, difference, sold_at')
      .eq('business_id', id).gt('difference', 0).gte('sold_at', start).lte('sold_at', end)),
    kinds.has('kitchen_removed')
      ? pageAll<any>(() => supabase.from('kitchen_voids').select('id, branch_id, cashier_id, created_at, cooked, amount')
        .eq('business_id', id).gte('created_at', start).lte('created_at', end))
      : Promise.resolve([]),
    kinds.has('parking_no_charge')
      ? pageAll<any>(() => supabase.from('parking_sessions').select('id, branch_id, ended_at')
        .eq('business_id', id).eq('status', 'voided').gte('ended_at', start).lte('ended_at', end))
      : Promise.resolve([]),
    supabase.from('branches').select('id, name').eq('business_id', id).limit(1000),
  ]);
  if (branches.error) throw new Error(branches.error.message);

  // Paid = a payment taken before the void (a 'completed' leg above 0; the void itself adds 'refunded' legs).
  const paidIds = new Set<string>();
  const voidIds = voided.map((o) => o.id as string);
  if (voidIds.length) {
    const pays = await chunkIn<any>('payments', 'order_id', voidIds, (q) => q.select('order_id, amount, status').eq('status', 'completed'));
    for (const p of pays) if (n(p.amount) > 0) paidIds.add(p.order_id);
  }
  // Prices below the list: who rang the sale up (the order's cashier).
  const priceOrders = new Map<string, string | null>();
  const priceIds = [...new Set(prices.map((p) => p.order_id as string).filter(Boolean))];
  if (priceIds.length) {
    for (const o of await chunkIn<any>('orders', 'id', priceIds, (q) => q.select('id, cashier_id').eq('business_id', id))) priceOrders.set(o.id, o.cashier_id ?? null);
  }

  return {
    businessType: biz.type ?? null,
    currency: biz.currency ?? 'KES',
    today,
    days: [lossPrevDate(today), today],
    week,
    branches: new Map(((branches.data ?? []) as any[]).map((b) => [b.id, b.name ?? 'Branch'])),
    people: new Map(users.map((u) => [u.id, u.name ?? ''])),
    // A shift counts its person on every business day it was open (opened → closed, or still open now).
    workers: shiftsWorked.filter((s) => s.cashier_id).flatMap((s) => {
      const from = dateOf(s.opened_at), to = dateOf(s.closed_at ?? end);
      return week.filter((d) => d >= from && d <= to).map((date) => ({ staff_id: s.cashier_id, branch_id: s.branch_id ?? null, date }));
    }),
    voids: voided.map((o) => ({ id: o.id, branch_id: o.branch_id ?? null, date: dateOf(o.voided_at ?? o.created_at), by: o.voided_by || o.cashier_id || null,
      total: n(o.total), paid: paidIds.has(o.id) })).filter((r) => inWeek.has(r.date)),
    refunds: refunded.map((o) => ({ id: o.id, branch_id: o.branch_id ?? null, date: dateOf(o.refunded_at), by: o.refunded_by || o.cashier_id || null,
      amount: n(o.refunded_amount) })).filter((r) => inWeek.has(r.date)),
    // A typed-in discount: no preset discount (discount_id) and more than the automatic offers took off (A445).
    discounts: discounted.map((o) => ({ id: o.id, branch_id: o.branch_id ?? null, date: dateOf(o.created_at), by: o.cashier_id ?? null,
      subtotal: n(o.subtotal), total: n(o.total), manual: o.discount_id ? 0 : Math.max(0, n(o.discount_amount) - n(o.offer_discount)) })),
    shifts: shiftsConfirmed.map((s) => ({ id: s.id, branch_id: s.branch_id ?? null, staff_id: s.cashier_id ?? null, date: dateOf(s.confirmed_at),
      difference: cashDifference(s) })).filter((s): s is any => s.difference !== null),
    dayCloses: days.filter((d) => d.cash_variance !== null && d.cash_variance !== undefined)
      .map((d) => ({ id: d.id, branch_id: d.branch_id ?? null, date: String(d.business_date).slice(0, 10), difference: n(d.cash_variance) })),
    prices: prices.map((p) => ({ id: p.id, branch_id: p.branch_id ?? null, date: dateOf(p.sold_at), by: priceOrders.get(p.order_id) ?? null, difference: n(p.difference) })),
    kitchen: kitchen.map((k) => ({ id: k.id, branch_id: k.branch_id ?? null, date: dateOf(k.created_at), by: k.cashier_id ?? null, cooked: k.cooked === true, amount: n(k.amount) })),
    parking: parking.map((p) => ({ id: p.id, branch_id: p.branch_id ?? null, date: dateOf(p.ended_at) })),
  };
}

/** The business's active people with their keys, branches and partner grant — the recipients' rules read these. */
export async function loadPeople(businessId: string): Promise<{ users: any[]; people: Person[]; ownerRoleIds: string[] }> {
  const { data, error } = await supabase.from('users')
    .select('id, name, email, status, roles ( name, role_permissions ( permissions ( key ) ) ), user_branches ( branch_id ), user_permissions ( granted, permissions ( key ) )')
    .eq('business_id', businessId).limit(5000);
  if (error) throw new Error(error.message);
  const users = (data ?? []) as any[];
  const { map: partners } = await readPartners(businessId);
  const people: Person[] = [];
  const ownerRoleIds: string[] = [];
  for (const u of users) {
    const role = Array.isArray(u.roles) ? u.roles[0] : u.roles;
    const ownerRole = isOwnerRoleName(role?.name);
    if (ownerRole) ownerRoleIds.push(u.id);
    if (u.status !== 'active') continue;
    const grant = partners[u.id];
    people.push({
      id: u.id, ownerRole,
      partner: !!grant && (grant.status === 'invited' || grant.status === 'active'),
      seesVoids: hasPermission(keysForRow({ roles: role ?? null, user_permissions: u.user_permissions ?? [] }, false), 'reports.voids'),
      branches: ((u.user_branches ?? []) as any[]).map((b) => b?.branch_id).filter(Boolean),
    });
  }
  return { users, people, ownerRoleIds };
}

const missingTable = (msg: string) => /loss_alerts/.test(msg) && /does not exist|not find|schema cache/i.test(msg);

/**
 * One business: detect, store (idempotent), notify the new ones once. Returns what was stored and what was told — the
 * tests read both. Nothing at all when the owner switched the alerts off.
 */
export async function runLossAlertsForBusiness(biz: Biz, now: Date = new Date()): Promise<{ stored: LossAlert[]; notified: LossAlert[]; pending?: number; today?: string; cutoff?: number }> {
  // A580: premium only (the Analytics switch) — a business without it gets nothing stored and nobody told.
  if (!(await analyticsEnabled(biz.id))) return { stored: [], notified: [] };
  const settings = await readLossSettingsFor(biz.id);
  if (!settings.enabled) return { stored: [], notified: [] };
  const { users, people, ownerRoleIds } = await loadPeople(biz.id);
  const input = await loadLossInput(biz, now, users);
  const alerts = detectLossAlerts(input, settings);
  const nowIso = now.toISOString();

  if (alerts.length) {
    // Upsert on (business_id, alert_key): the same alert again is an update — never notified_at / dismissed_* (kept).
    const rows = alerts.map((a) => ({
      business_id: biz.id, alert_key: a.key, kind: a.kind, period: a.period, business_date: a.business_date,
      branch_id: a.branch_id, staff_id: a.staff_id, count: a.count, amount: a.amount, peer_low: a.peer_low, peer_high: a.peer_high,
      score: a.score, message: a.message.slice(0, 600), link: a.link.slice(0, 600), updated_at: nowIso,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('loss_alerts').upsert(rows.slice(i, i + 200), { onConflict: 'business_id,alert_key' });
      if (error) {
        if (missingTable(error.message)) { console.warn('[lossAlerts] loss_alerts is missing — run migration 166.'); return { stored: [], notified: [] }; }
        throw new Error(error.message);
      }
    }
  }

  // What was told before (the last 8 days) decides what is told now.
  const { data: storedRows, error: sErr } = await supabase.from('loss_alerts')
    .select('id, alert_key, kind, period, branch_id, staff_id, business_date, notified_at')
    .eq('business_id', biz.id).gte('business_date', lossPrevDate(input.today, LOSS_WEEK_DAYS)).limit(5000);
  if (sErr) {
    if (missingTable(sErr.message)) return { stored: [], notified: [] };
    throw new Error(sErr.message);
  }
  const stored = ((storedRows ?? []) as any[]).map((r) => ({ ...r, business_date: String(r.business_date).slice(0, 10) })) as Array<StoredAlert & { id: string }>;
  const fresh = toNotify(alerts, stored, input.today);
  const pending = fresh.length;   // A591: something to tell this run — the next run is not skipped
  const told: LossAlert[] = [];
  const ownerIds = [...new Set([biz.owner_id, ...ownerRoleIds].filter(Boolean) as string[])];
  for (const a of fresh) {
    const notes: any[] = [];
    const title = notificationTitle(a.kind, biz.type);
    if (biz.owner_id && ownerTold(a, ownerIds, settings)) {
      notes.push({ business_id: biz.id, branch_id: a.branch_id, user_id: biz.owner_id, type: LOSS_NOTIFY_TYPE, title, message: a.message, link: a.link });
    }
    for (const uid of teamRecipients(a, people, settings)) {
      notes.push({ business_id: biz.id, branch_id: a.branch_id, user_id: uid, type: LOSS_TEAM_NOTIFY_TYPE, title, message: a.message, link: a.link });
    }
    if (notes.length) {
      const { error } = await supabase.from('notifications').insert(notes);
      if (error) { console.error(`[lossAlerts] ${biz.name}: notifications not written:`, error.message); continue; }   // not stamped: tried again
    }
    const row = stored.find((r) => r.alert_key === a.key);
    const { error: uErr } = row
      ? await supabase.from('loss_alerts').update({ notified_at: nowIso }).eq('id', row.id)
      : await supabase.from('loss_alerts').update({ notified_at: nowIso }).eq('business_id', biz.id).eq('alert_key', a.key);
    if (uErr) console.error(`[lossAlerts] ${biz.name}: notified_at not stamped:`, uErr.message);
    told.push(a);
  }
  if (alerts.length || told.length) console.log(`[lossAlerts] ${biz.name}: ${alerts.length} alert(s), ${told.length} told`);
  return { stored: alerts, notified: told, pending, today: input.today, cutoff: await getDayCutoff(biz.id) };
}

/**
 * A576: the daily email's "Worth a look" block — today's alerts worked out fresh, not looked into yet, at most 10, none
 * about a person the email goes to. '' when the owner switched the alerts (or this part) off, there are none, or migration
 * 166 has not run. Never throws: the daily email goes regardless.
 */
export async function lossEmailHtml(biz: { id: string; name: string; owner_id: string | null; currency: string | null }, recipients: string[], now: Date): Promise<string> {
  try {
    if (!(await analyticsEnabled(biz.id))) return '';   // A580: premium only — no block in a non-premium owner's email
    const settings = await readLossSettingsFor(biz.id);
    if (!settings.enabled || !settings.daily_email) return '';
    const { data: b } = await supabase.from('businesses').select('type').eq('id', biz.id).maybeSingle();
    await runLossAlertsForBusiness({ ...biz, type: (b as any)?.type ?? null }, now);
    const today = businessDateEAT(now, await getDayCutoff(biz.id));
    const { data, error } = await supabase.from('loss_alerts')
      .select('id, staff_id, score, business_date, count, message, link')
      .eq('business_id', biz.id).eq('business_date', today).is('dismissed_at', null).limit(500);
    if (error || !data?.length) return '';
    const rows = (data as any[]).map((r) => ({ ...r, score: Number(r.score) || 0, count: Number(r.count) || 0, business_date: String(r.business_date).slice(0, 10) }));
    const ids = [...new Set(rows.map((r) => r.staff_id).filter(Boolean))] as string[];
    const emails = new Map<string, string>();
    if (ids.length) for (const u of await chunkIn<any>('users', 'id', ids, (q) => q.select('id, email'))) if (u.email) emails.set(u.id, String(u.email));
    return lossAlertsSection(emailLines(rows, emails, recipients));
  } catch (e: any) {
    console.error(`[lossAlerts] daily email block failed for ${biz.name}:`, e?.message);
    return '';
  }
}
