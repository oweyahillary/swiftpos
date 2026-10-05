import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { getDayCutoff } from '../lib/dayCutoff';
import { businessDateEAT, businessRangeEAT } from '../lib/businessDay';
import { REQUIRED_DESKTOP_SCHEMA } from '../lib/desktopSchema';
import { notifyAdmin, alertChannels } from '../lib/alertNotify';
import { recentErrors, digestCounters, recentSignInFailures, recentSyncAttempts } from '../lib/watchdogCounters';
import {
  Alert, OpenAlertRow, WATCHDOG, planRun, alertText, digestText,
  tillsNotSyncing, mpesaUnanswered, paymentExceptions, errorBurst, daysNotClosed, oldTills, etimsFailures,
  repeatedSignInFailures, tillSyncRefused, tillsSignedOut,
} from '../lib/watchdogRules';

/**
 * Watchdog — A383. Owner, 2026-10-03: "getting this errors critical one first hand before the client calls …
 * proactive not reactive" — "telegram and email combo is fine".
 *
 * Every 10 minutes: run the rules (lib/watchdogRules.ts) over every active client, compare with what it already said
 * (public.watchdog_alerts, migration 116), send the NEW critical problems at once, remind every 3 hours while one lasts,
 * and say "resolved" when it clears. Every morning (07:45 East Africa Time): one digest of everything open, the
 * warnings included, and the counters (server errors, failed sign-ins, A159 write-guard flags).
 * A392: only critical problems are emailed (new and still happening); "resolved" and the digest go to Telegram, and
 * everything shows on the admin portal's Alerts page.
 *
 * A total cloud outage cannot be reported from inside the cloud: UptimeRobot watches /health for that.
 * WATCHDOG_ENABLED=false turns it off. Never throws: a failed check is logged and the next run tries again.
 */

const DAY_MS = 24 * 60 * 60_000;

async function names(): Promise<{ active: string[]; names: Record<string, string>; approved: Record<string, string | null> }> {
  const { data } = await supabase
    .from('businesses')
    .select('id, name, status, suspended_at, desktop_approved_version')
    .eq('status', 'active');
  const rows = ((data ?? []) as any[]).filter((b) => !b.suspended_at);
  return {
    active: rows.map((b) => b.id),
    names: Object.fromEntries(rows.map((b) => [b.id, b.name])),
    approved: Object.fromEntries(rows.map((b) => [b.id, b.desktop_approved_version ?? null])),
  };
}

/** Every problem found right now, critical and warning. Each check on its own: one failing never hides the others. */
export async function collectAlerts(now = new Date()): Promise<Alert[]> {
  const { active, names: nm, approved } = await names();
  const alerts: Alert[] = [];
  const inActive = (r: any) => active.includes(r.business_id);
  const step = async (label: string, f: () => Promise<Alert[]>) => {
    try { alerts.push(...await f()); } catch (err: any) { console.error(`[watchdog] ${label} check failed:`, err?.message ?? err); }
  };

  await step('errors', async () => { const e = recentErrors(); return errorBurst(e.times, now, e.paths); });
  await step('sign-ins', async () => repeatedSignInFailures(recentSignInFailures(), now));   // A392
  await step('sync refused', async () => {                                                 // A392
    const attempts = recentSyncAttempts();
    const ids = [...new Set(attempts.map((l) => l[l.length - 1]?.deviceId).filter(Boolean))] as string[];
    const tills: Record<string, string> = {};
    if (ids.length) {
      const { data } = await supabase.from('user_devices').select('device_id, terminal_code, device_label').in('device_id', ids.slice(0, 500));
      for (const d of (data ?? []) as any[]) tills[d.device_id] = d.terminal_code || d.device_label || tills[d.device_id];
    }
    return tillSyncRefused(attempts, now, nm, tills);
  });
  if (!active.length) return alerts;

  await step('tills', async () => {
    const { data, error } = await supabase
      .from('user_devices')
      .select('id, business_id, device_label, terminal_code, status, retired_at, last_seen_at, last_sync_at, app_version, schema_version')
      .in('business_id', active)
      .is('retired_at', null);
    if (error) throw error;
    const devices = ((data ?? []) as any[]).filter(inActive);
    return [...tillsNotSyncing(devices, now, nm), ...oldTills(devices, approved, REQUIRED_DESKTOP_SCHEMA, nm)];
  });

  // A407: tills signed out that could not sign back in — read on their own so a cloud before migration 125 still runs
  // every other check.
  await step('tills signed out', async () => {
    const { data, error } = await supabase
      .from('user_devices')
      .select('id, business_id, device_label, terminal_code, status, retired_at, session_lost_at, session_lost_reason')
      .in('business_id', active)
      .is('retired_at', null)
      .not('session_lost_at', 'is', null);
    if (error) throw error;
    return tillsSignedOut(((data ?? []) as any[]).filter(inActive), now, nm);
  });

  await step('mpesa', async () => {
    const { data, error } = await supabase
      .from('payments')
      .select('id, business_id, status, mpesa_requested_at, amount')
      .eq('status', 'pending')
      .not('mpesa_checkout_id', 'is', null)
      .gte('mpesa_requested_at', new Date(now.getTime() - WATCHDOG.MPESA_WINDOW_MIN * 60_000).toISOString())
      .limit(1000);
    if (error) throw error;
    return mpesaUnanswered(((data ?? []) as any[]).filter(inActive), now, nm);
  });

  await step('payment exceptions', async () => {
    const { data, error } = await supabase
      .from('payment_exceptions')
      .select('id, business_id, reason, resolved_at, created_at')
      .is('resolved_at', null)
      .gte('created_at', new Date(now.getTime() - 7 * DAY_MS).toISOString())
      .limit(500);
    if (error) throw error;
    return paymentExceptions(((data ?? []) as any[]).filter(inActive), nm);
  });

  await step('days', async () => {
    const { data, error } = await supabase
      .from('business_days')
      .select('id, business_id, branch_id, terminal_code, business_date, status')
      .eq('status', 'open')
      .gte('business_date', new Date(now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10))
      .limit(1000);
    if (error) throw error;
    const rows: any[] = [];
    for (const d of ((data ?? []) as any[]).filter(inActive)) {
      const cutoff = await getDayCutoff(d.business_id, d.branch_id);
      if (d.business_date >= businessDateEAT(now, cutoff)) continue;               // today's day: still trading
      const end = Date.parse(businessRangeEAT(d.business_date, d.business_date, cutoff).end) + 1;
      rows.push({ ...d, ends_at: new Date(end).toISOString() });
    }
    return daysNotClosed(rows, now, nm);
  });

  await step('etims', async () => {
    const { data, error } = await supabase
      .from('etims_invoices')
      .select('business_id, status')
      .eq('status', 'failed')
      .gte('created_at', new Date(now.getTime() - DAY_MS).toISOString())
      .limit(2000);
    if (error) throw error;
    return etimsFailures(((data ?? []) as any[]).filter(inActive), nm);
  });

  return alerts;
}

const OPEN_COLS = 'id, alert_key, severity, title, detail, first_seen_at, last_notified_at, notify_count';

async function openAlerts(): Promise<OpenAlertRow[]> {
  let { data, error } = await supabase
    .from('watchdog_alerts').select(`${OPEN_COLS}, acknowledged_at`).is('resolved_at', null);
  if (error && /acknowledged_at/.test(error.message ?? '')) {      // before migration 119: no mute, the rest works
    ({ data, error } = await supabase.from('watchdog_alerts').select(OPEN_COLS).is('resolved_at', null) as any);
  }
  if (error) throw error;
  return (data ?? []) as OpenAlertRow[];
}

/** One run: find, compare, store, send. */
export async function runWatchdog(now = new Date()): Promise<{ opened: number; reminded: number; resolved: number }> {
  const current = await collectAlerts(now);
  const plan = planRun(current, await openAlerts(), now);
  const iso = now.toISOString();

  for (const a of plan.opened) {
    const critical = a.severity === 'critical';
    if (critical) await notifyAdmin(`ZapTill alert: ${a.title}`, alertText('new', a));
    const { error } = await supabase.from('watchdog_alerts').insert({
      alert_key: a.key, severity: a.severity, business_id: a.businessId, title: a.title, detail: a.detail,
      first_seen_at: iso, last_seen_at: iso,
      last_notified_at: critical ? iso : null, notify_count: critical ? 1 : 0,
    });
    if (error) console.error('[watchdog] could not store alert', a.key, error.message);
  }

  const due = new Set(plan.remind.map((r) => r.row.id));
  for (const { row, alert } of plan.stillOpen) {
    const patch: Record<string, unknown> = { last_seen_at: iso, severity: alert.severity, title: alert.title, detail: alert.detail };
    if (due.has(row.id)) {
      // A warning that became critical is news; a critical one still there is a reminder.
      const kind = row.severity === 'critical' ? 'reminder' : 'new';
      await notifyAdmin(`ZapTill ${kind === 'new' ? 'alert' : 'still happening'}: ${alert.title}`, alertText(kind, alert, row.first_seen_at, now));
      patch.last_notified_at = iso;
      patch.notify_count = (row.notify_count ?? 0) + 1;
    }
    const { error } = await supabase.from('watchdog_alerts').update(patch).eq('id', row.id);
    if (error) console.error('[watchdog] could not update alert', row.alert_key, error.message);
  }

  for (const row of plan.resolved) {
    if (row.last_notified_at) {                             // told about it (as critical) → say it cleared
      // A392: not emailed — a recovery is not a critical failure (Telegram and the portal only).
      await notifyAdmin(`ZapTill resolved: ${row.title}`, alertText('resolved', row, row.first_seen_at, now), { email: false });
    }
    const { error } = await supabase.from('watchdog_alerts').update({ resolved_at: iso }).eq('id', row.id);
    if (error) console.error('[watchdog] could not resolve alert', row.alert_key, error.message);
  }

  return { opened: plan.opened.length, reminded: plan.remind.length, resolved: plan.resolved.length };
}

/** The morning digest: everything still open (critical first), then the counters since the last digest. */
export async function sendDigest(now = new Date()): Promise<void> {
  const open = await openAlerts();
  open.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  const text = digestText(open, digestCounters(true), now);
  // A392: the digest is not emailed (critical failures only) — Telegram, and the admin portal's Alerts page.
  await notifyAdmin(`ZapTill daily check — ${now.toISOString().slice(0, 10)}`, text, { email: false });
}

export function startWatchdogJob(): void {
  if (String(process.env.WATCHDOG_ENABLED ?? 'true').toLowerCase() === 'false') {
    console.log('[watchdog] off (WATCHDOG_ENABLED=false)');
    return;
  }
  const ch = alertChannels();
  if (!ch.telegram && !ch.email) {
    console.warn('[watchdog] no alert channel set (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or ADMIN_ALERT_EMAIL) — problems are only logged');
  }
  let running = false;
  const schedule = process.env.WATCHDOG_CRON ?? '*/10 * * * *';
  cron.schedule(schedule, async () => {
    if (running) return;                                   // a slow run never overlaps the next
    running = true;
    try {
      const r = await runWatchdog();
      if (r.opened || r.reminded || r.resolved) console.log(`[watchdog] new ${r.opened}, reminded ${r.reminded}, resolved ${r.resolved}`);
    } catch (err: any) {
      console.error('[watchdog] run failed:', err?.message ?? err);
    } finally {
      running = false;
    }
  }, { timezone: 'UTC' });

  // 07:45 East Africa Time — before the shops open.
  const digest = process.env.WATCHDOG_DIGEST_CRON ?? '45 7 * * *';
  cron.schedule(digest, async () => {
    try { await sendDigest(); } catch (err: any) { console.error('[watchdog] digest failed:', err?.message ?? err); }
  }, { timezone: 'Africa/Nairobi' });
  console.log(`[watchdog] Scheduled: checks ${schedule} UTC, digest ${digest} Africa/Nairobi — Telegram ${ch.telegram ? 'on' : 'off'}, email ${ch.email ? 'on' : 'off'}`);
}
