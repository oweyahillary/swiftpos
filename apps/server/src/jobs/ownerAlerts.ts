/**
 * ownerAlerts.ts (job) — A476: the owner's emails beyond the daily report, every 15 minutes, per business.
 *
 * Owner, 2026-10-14: "tills not confirmed or closed by manager, and any other important email but the owner can turn
 * them off. Branch manager should always get an email about tills which are not closed."
 *
 *   1. Branch managers — ALWAYS (not switchable, independent of the owner's daily report): each branch's managers get
 *      that branch's drawers still open or closed-but-not-confirmed, at the business's send_time (default 21:00) and
 *      again at 09:00 EAT if any from an earlier day are still not done. Nothing is sent when there are none.
 *      Dedup per branch per slot: business_settings 'branch_open_tills_last_sent:<branch_id>' = '<date>:<slot>'.
 *   2. Alerts as they happen (each switchable in Settings › Report Scheduler, all on by default), to the owner and the
 *      scheduler's added addresses; the not-syncing alert also to that branch's managers:
 *        a till not synced for N hours while its branch trades, or signed out and unable to sign back in — once per
 *        incident, again only after it recovered; a void or refund ≥ the amount — once per void; a shift confirmed
 *        with |cash difference| ≥ the amount — once per shift. Remembered in 'owner_alerts_state'.
 *   3. The weekly summary (off by default): Monday 08:00 EAT, last week against the week before, once per week
 *      ('weekly_summary_last_sent').
 *
 * One business failing (a read, a provider refusing a message) never stops the others; a failed send is not stamped,
 * so it is tried again on the next run.
 */
import cron from 'node-cron';
import { format as tzFormat } from 'date-fns-tz';
import { supabase } from '../lib/supabase';
import { sendEmail } from '../lib/mailer';
import { getDayCutoff } from '../lib/dayCutoff';
import { businessDateEAT, businessRangeEAT } from '../lib/businessDay';
import { readReportSchedule, gatherRecipients } from './dailySummary';
import {
  readAlerts, decideBranchSlot, selectOpenTills, decideNotSyncing, tillTrading, bigReversals, bigVariances,
  readAlertState, pruneSent, decideWeeklySend, decideSecurityAlert, type AlertState,
} from './ownerAlertsDecision';
import { branchOpenTillsEmail, notSyncingAlertEmail, bigReversalAlertEmail, varianceAlertEmail, weeklySummaryEmail, tillSecurityAlertEmail } from './ownerEmails';
import {
  loadOpenShifts, openTillLines, branchNames, branchManagerEmails, managersOf, ownerAndExtras, loadDevices, deviceName,
  userNames, varianceLine, weekFigures, type OpenShiftRow,
} from './ownerAlertsData';

const EAT = 'Africa/Nairobi';
export const BRANCH_TILLS_KEY = 'branch_open_tills_last_sent:';
export const ALERT_STATE_KEY = 'owner_alerts_state';
export const WEEKLY_KEY = 'weekly_summary_last_sent';
/** Keys this job owns — POST /api/business/settings refuses to write them. */
export const isOwnerAlertJobKey = (key: string): boolean =>
  key === ALERT_STATE_KEY || key === WEEKLY_KEY || key.startsWith(BRANCH_TILLS_KEY);

/** How far back the alert job looks for voids, refunds and confirmations (a till may sync a void hours late). */
const LOOKBACK_MS = 48 * 3_600_000;

type Biz = { id: string; name: string; owner_id: string; currency: string | null };

export function startOwnerAlertsJob(): void {
  const schedule = process.env.OWNER_ALERTS_CRON ?? '*/15 * * * *';
  cron.schedule(schedule, async () => {
    try { await runOwnerAlertsTick(new Date()); } catch (err: any) { console.error('[ownerAlerts] Job failed:', err?.message); }
  }, { timezone: 'UTC' });
  console.log(`[ownerAlerts] Scheduled: ${schedule} (branch tills, alerts, weekly summary)`);
}

// ── settings rows ────────────────────────────────────────────────────────────

async function readSetting(businessId: string, key: string): Promise<unknown> {
  const { data, error } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', key).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

async function writeSetting(businessId: string, key: string, value: unknown): Promise<void> {
  const { data: existing, error: rErr } = await supabase.from('business_settings').select('id')
    .eq('business_id', businessId).eq('key', key).maybeSingle();
  if (rErr) throw new Error(rErr.message);
  const { error } = existing
    ? await supabase.from('business_settings').update({ value, updated_at: new Date().toISOString() }).eq('id', existing.id)
    : await supabase.from('business_settings').insert({ business_id: businessId, key, value });
  if (error) throw new Error(error.message);
}

const asText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).replace(/"/g, ''));

// ── the tick ─────────────────────────────────────────────────────────────────

export async function runOwnerAlertsTick(now: Date = new Date()): Promise<void> {
  const { data: businesses, error } = await supabase.from('businesses').select('id, name, owner_id, currency');
  if (error) { console.error('[ownerAlerts] businesses:', error.message); return; }
  for (const biz of (businesses ?? []) as Biz[]) {
    let schedule: any;
    try { schedule = await readReportSchedule(biz.id); } catch (e: any) { console.error(`[ownerAlerts] ${biz.name}: schedule:`, e?.message); continue; }
    for (const [name, step] of [
      ['branch tills', () => branchOpenTillsForBusiness(biz, schedule, now)],
      ['alerts', () => alertsForBusiness(biz, schedule, now)],
      ['weekly', () => weeklyForBusiness(biz, schedule, now)],
    ] as const) {
      try { await step(); } catch (e: any) { console.error(`[ownerAlerts] ${name} failed for ${biz.name} (${biz.id}):`, e?.message); }
    }
  }
}

// ── 1. branch managers: tills not closed (always) ────────────────────────────

export async function branchOpenTillsForBusiness(biz: Biz, schedule: { send_time?: string }, now: Date): Promise<number> {
  const nowDate = tzFormat(now, 'yyyy-MM-dd', { timeZone: EAT });
  const nowHHMM = tzFormat(now, 'HH:mm', { timeZone: EAT });
  // cheap exit: no slot can be due before the earlier of 09:00 and send_time
  if (!decideBranchSlot(nowDate, nowHHMM, schedule.send_time, null)) return 0;

  const branches = await branchNames(biz.id);
  if (!branches.size) return 0;
  const keys = [...branches.keys()].map((id) => `${BRANCH_TILLS_KEY}${id}`);
  const { data: stamps, error } = await supabase.from('business_settings').select('key, value')
    .eq('business_id', biz.id).in('key', keys);
  if (error) throw new Error(error.message);
  const last = new Map(((stamps ?? []) as any[]).map((r) => [r.key, asText(r.value)]));

  const cutoff = await getDayCutoff(biz.id);
  const reportDate = businessDateEAT(now, cutoff);
  let shifts: OpenShiftRow[] | null = null;
  let managers: Awaited<ReturnType<typeof branchManagerEmails>> | null = null;
  let sent = 0;

  for (const [branchId, branchName] of branches) {
    try {
      const key = `${BRANCH_TILLS_KEY}${branchId}`;
      const due = decideBranchSlot(nowDate, nowHHMM, schedule.send_time, last.get(key) ?? null);
      if (!due) continue;
      shifts ??= await loadOpenShifts(biz.id);
      const rows = selectOpenTills(shifts.filter((s) => s.branch_id === branchId), reportDate, cutoff, due.slot);
      if (rows.length) {
        managers ??= await branchManagerEmails(biz.id);
        const to = managersOf(managers, branchId);
        if (to.length) {
          const lines = await openTillLines(biz.id, rows, branches);
          const mail = branchOpenTillsEmail({ businessName: biz.name, branchName, slot: due.slot, lines, currency: biz.currency ?? 'KES' });
          await sendEmail({ to: to.join(', '), subject: mail.subject, html: mail.html });
          sent++;
          console.log(`[ownerAlerts] ${biz.name} · ${branchName}: ${rows.length} till(s) not done → ${to.length} manager(s) (${due.slot})`);
        } else {
          console.warn(`[ownerAlerts] ${biz.name} · ${branchName}: ${rows.length} till(s) not done but no manager with an email`);
        }
      }
      await writeSetting(biz.id, key, due.stamp);   // after the send (or nothing to send): once per branch per slot
    } catch (e: any) {
      console.error(`[ownerAlerts] branch tills failed for ${biz.name} · ${branchName}:`, e?.message);
    }
  }
  return sent;
}

// ── 2. alerts as they happen ─────────────────────────────────────────────────

export async function alertsForBusiness(biz: Biz, schedule: any, now: Date): Promise<number> {
  const s = readAlerts(schedule);
  if (!s.alert_not_syncing && !s.alert_big_void && !s.alert_variance) return 0;
  const state: AlertState = readAlertState(await readSetting(biz.id, ALERT_STATE_KEY));
  const before = JSON.stringify(state);
  const seeding = !state.seeded;            // the first run records what is already there and emails none of it
  const currency = biz.currency ?? 'KES';
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const nowIso = now.toISOString();
  let ownerTo: string[] | null = null;
  const owner = async () => (ownerTo ??= await ownerAndExtras(biz, schedule));
  const branches = await branchNames(biz.id);
  let sent = 0;

  if (s.alert_not_syncing) {
    const devices = await loadDevices(biz.id);
    const { data: open, error } = await supabase.from('shifts').select('branch_id')
      .eq('business_id', biz.id).eq('status', 'open').limit(500);
    if (error) throw new Error(error.message);
    const trading = new Set(((open ?? []) as any[]).map((r) => r.branch_id).filter(Boolean) as string[]);
    let managers: Awaited<ReturnType<typeof branchManagerEmails>> | null = null;
    const next: Record<string, string> = {};
    for (const d of devices) {
      // A477: the till's sign-in used from another computer — to the owner, once per incident.
      const sec = decideSecurityAlert(d, state.sent, now);
      if (sec.send && sec.key) {
        if (seeding) state.sent[sec.key] = nowIso;
        else {
          try {
            const to = await owner();
            if (to.length) {
              const mail = tillSecurityAlertEmail({ businessName: biz.name, branchName: (d.branch_id && branches.get(d.branch_id)) || '',
                till: deviceName(d), reason: d.security_alert_reason ?? null, at: d.security_alert_at ?? null });
              await sendEmail({ to: to.join(', '), subject: mail.subject, html: mail.html });
              sent++;
            }
            state.sent[sec.key] = nowIso;
          } catch (e: any) {
            console.error(`[ownerAlerts] security alert failed for ${biz.name} · ${deviceName(d)}:`, e?.message);   // not stamped: tried again
          }
        }
      }
      const prev = state.not_syncing[d.id];
      const dec = decideNotSyncing(d, now, s.not_syncing_hours, tillTrading(d, trading, now), prev);
      if (dec.next) next[d.id] = dec.next;
      if (!dec.send || !dec.kind) continue;
      try {
        managers ??= await branchManagerEmails(biz.id);
        const to = [...new Set([...(await owner()), ...(d.branch_id ? managersOf(managers, d.branch_id) : [])])];
        if (to.length) {
          const branchName = (d.branch_id && branches.get(d.branch_id)) || '';
          const mail = notSyncingAlertEmail({
            businessName: biz.name, branchName, till: deviceName(d), kind: dec.kind, hours: dec.hours,
            lastSyncAt: d.last_sync_at ?? null, reason: (d as any).session_lost_reason ?? null,
          });
          await sendEmail({ to: to.join(', '), subject: mail.subject, html: mail.html });
          sent++;
        }
      } catch (e: any) {
        // not sent: forget this incident so the next run tries again
        if (prev) next[d.id] = prev; else delete next[d.id];
        console.error(`[ownerAlerts] not-syncing alert failed for ${biz.name} · ${deviceName(d)}:`, e?.message);
      }
    }
    state.not_syncing = next;
  }

  if (s.alert_big_void) {
    const [v, r] = await Promise.all([
      supabase.from('orders').select('id, order_number, total, void_reason, cashier_id, voided_by, authorized_by, branch_id, voided_at, created_at')
        .eq('business_id', biz.id).eq('status', 'voided').gte('voided_at', since).gte('total', s.big_void_amount)
        .order('voided_at', { ascending: true }).limit(200),
      supabase.from('orders').select('id, order_number, refunded_amount, refund_reason, cashier_id, refunded_by, refund_authorized_by, branch_id, refunded_at')
        .eq('business_id', biz.id).not('refunded_at', 'is', null).gte('refunded_at', since).gte('refunded_amount', s.big_void_amount)
        .order('refunded_at', { ascending: true }).limit(200),
    ]);
    if (v.error) throw new Error(v.error.message);
    if (r.error) throw new Error(r.error.message);
    const rows = [
      ...((v.data ?? []) as any[]).map((o) => ({ id: o.id, kind: 'void' as const, amount: Number(o.total) || 0, o, by: o.voided_by || o.cashier_id, ok: o.authorized_by, reason: o.void_reason, at: o.voided_at || o.created_at })),
      ...((r.data ?? []) as any[]).map((o) => ({ id: o.id, kind: 'refund' as const, amount: Number(o.refunded_amount) || 0, o, by: o.refunded_by || o.cashier_id, ok: o.refund_authorized_by, reason: o.refund_reason, at: o.refunded_at })),
    ];
    const fresh = bigReversals(rows, s.big_void_amount, state.sent);
    if (fresh.length) {
      let delivered = seeding;
      if (!seeding) {
        const to = await owner();
        if (to.length) {
          const people = await userNames(fresh.flatMap((x) => [x.by, x.ok]));
          const mail = bigReversalAlertEmail({
            businessName: biz.name, currency, threshold: s.big_void_amount,
            lines: fresh.map((x) => ({
              kind: x.kind, orderNumber: String(x.o.order_number ?? x.id).slice(0, 40), branch: branches.get(x.o.branch_id) ?? '',
              cashier: (x.by && people.get(x.by)) || 'Unknown', approvedBy: x.ok ? (people.get(x.ok) ?? null) : null,
              amount: x.amount, reason: x.reason ?? null, at: x.at ?? null,
            })),
          });
          try { await sendEmail({ to: to.join(', '), subject: mail.subject, html: mail.html }); delivered = true; sent++; }
          catch (e: any) { console.error(`[ownerAlerts] big-void alert failed for ${biz.name}:`, e?.message); }
        } else delivered = true;   // nobody to tell: do not pile them up
      }
      if (delivered) for (const x of fresh) state.sent[`${x.kind}:${x.id}`] = nowIso;
    }
  }

  if (s.alert_variance) {
    const { data, error } = await supabase.from('shifts')
      .select('id, branch_id, cashier_id, device_id, terminal_code, expected_methods, confirmed_methods, cash_variance, confirm_reasons, confirmed_at, confirmed_by')
      .eq('business_id', biz.id).gte('confirmed_at', since).order('confirmed_at', { ascending: true }).limit(500);
    if (error) throw new Error(error.message);
    const fresh = bigVariances((data ?? []) as any[], s.variance_amount, state.sent);
    if (fresh.length) {
      let delivered = seeding;
      if (!seeding) {
        const to = await owner();
        if (to.length) {
          const people = await userNames(fresh.flatMap((x: any) => [x.cashier_id, x.confirmed_by]));
          const tills = new Map<string, string>();
          try { for (const d of await loadDevices(biz.id)) if (d.device_id) tills.set(d.device_id, deviceName(d)); } catch { /* names only */ }
          const mail = varianceAlertEmail({
            businessName: biz.name, currency, threshold: s.variance_amount,
            lines: fresh.map((x: any) => varianceLine(x, x.difference, branches, people, tills)),
          });
          try { await sendEmail({ to: to.join(', '), subject: mail.subject, html: mail.html }); delivered = true; sent++; }
          catch (e: any) { console.error(`[ownerAlerts] variance alert failed for ${biz.name}:`, e?.message); }
        } else delivered = true;
      }
      if (delivered) for (const x of fresh) state.sent[`shift:${x.id}`] = nowIso;
    }
  }

  state.sent = pruneSent(state.sent, now);
  state.seeded = true;
  if (JSON.stringify(state) !== before) await writeSetting(biz.id, ALERT_STATE_KEY, state);
  return sent;
}

// ── 3. the weekly summary ────────────────────────────────────────────────────

export async function weeklyForBusiness(biz: Biz, schedule: any, now: Date): Promise<boolean> {
  const s = readAlerts(schedule);
  if (!s.weekly_summary) return false;
  const nowDate = tzFormat(now, 'yyyy-MM-dd', { timeZone: EAT });
  const nowHHMM = tzFormat(now, 'HH:mm', { timeZone: EAT });
  const plan = decideWeeklySend(true, nowDate, nowHHMM, asText(await readSetting(biz.id, WEEKLY_KEY)));
  if (!plan) return false;
  const recipients = await gatherRecipients(biz, schedule);
  if (!recipients.length) { console.warn(`[ownerAlerts] ${biz.name}: weekly summary on but no recipients — skipping.`); return false; }
  const cutoff = await getDayCutoff(biz.id);
  const cur = await weekFigures(biz.id, businessRangeEAT(plan.thisFrom, plan.thisTo, cutoff), plan.thisFrom, plan.thisTo);
  const prev = await weekFigures(biz.id, businessRangeEAT(plan.prevFrom, plan.prevTo, cutoff), plan.prevFrom, plan.prevTo);
  const mail = weeklySummaryEmail({ businessName: biz.name, currency: biz.currency ?? 'KES', thisFrom: plan.thisFrom, thisTo: plan.thisTo, cur, prev });
  await sendEmail({ to: recipients.join(', '), subject: mail.subject, html: mail.html });
  await writeSetting(biz.id, WEEKLY_KEY, plan.stamp);   // after a successful send: a failure retries next run
  console.log(`[ownerAlerts] Weekly summary ${plan.thisFrom}..${plan.thisTo} for ${biz.name} → ${recipients.length} recipient(s)`);
  return true;
}
