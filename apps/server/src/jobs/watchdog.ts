import { meterJob } from '../lib/supabaseMeter';   // A591: this job's Supabase calls, counted
import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { getDayCutoff, primeDayCutoffs } from '../lib/dayCutoff';   // A593: primeDayCutoffs
import { memoEnabled } from '../lib/writeActivity';   // A593
import { opsEventsGen } from '../lib/opsEvents';     // A593
import { businessDateEAT, businessRangeEAT } from '../lib/businessDay';
import { REQUIRED_DESKTOP_SCHEMA } from '../lib/desktopSchema';
import { notifyRendered, alertChannels, alertLinks } from '../lib/alertNotify';   // A592: laid out by lib/alertFormat.ts
import { recentErrors, digestCounters, recentSignInFailures, recentSyncAttempts, syncQueueReports, requestLoad } from '../lib/watchdogCounters';
import { lapsedBusinessIds, billingDigestLines, billingStandingRows } from '../lib/cloudPlan';   // A581, A584, A589
import { startLoopMonitor, takeLoopLag } from '../lib/serverLoad';                                // A589
import { readAlertSettings, addAdminNotifications, readDigestDate, writeDigestDate } from '../lib/adminAlerts';   // A589
import {
  routeRun, digestEmail, digestTelegram, billingSummaryEmail, problemFacts, digestDue, nairobiClock, type DigestRow, type BillingRow,
} from '../lib/adminAlertPolicy';                                                                 // A589
import {
  Alert, OpenAlertRow, WATCHDOG, planRun, DeviceRow, TradeEvidence,
  tillsNotSyncing, quietCandidates, tillsWithParkedRecords, mpesaUnanswered, paymentExceptions, errorBurst, daysNotClosed, oldTills, etimsFailures,
  repeatedSignInFailures, tillSyncRefused, tillsSignedOut, serverOverload, databaseUnreachable, backupMissed,
} from '../lib/watchdogRules';

/**
 * Watchdog — A383. Owner, 2026-10-03: "getting this errors critical one first hand before the client calls …
 * proactive not reactive" — "telegram and email combo is fine".
 *
 * Every 10 minutes: run the rules (lib/watchdogRules.ts) over every active client, compare with what it already said
 * (public.watchdog_alerts, migration 116), tell the NEW critical problems, remind every 3 hours while one lasts, and say
 * "resolved" when it clears. Every morning: one digest of everything open, the warnings included, and the counters
 * (server errors, failed sign-ins, A159 write-guard flags).
 *
 * A589 (owner, 2026-10-25: "till not closed should not come as an email for each client; let it be a notification on the
 * admin portal … or if they must come as an email let it be a table containing the clients list, not each client an
 * email; also invoices let it be the same; [emails] maybe when the server is down or overloaded"). Who hears what is
 * lib/adminAlertPolicy.ts routeRun, by the super admin's settings (public.admin_settings, migration 174):
 *   • a CLIENT problem (a day not closed, a POS not syncing / signed out / refused, M-Pesa, eTIMS) — the admin portal's
 *     bell (public.admin_notifications) and Alerts page; ONE Telegram message per run listing the new ones; no email —
 *     the morning digest email has them all in ONE table (client | branch / POS | problem | since), still-open only;
 *   • a SYSTEM emergency (server errors, overloaded, database unreachable, a sign-in attack, the backup missed) — an
 *     email + Telegram at once, one each, reminded every 3 hours (as before);
 *   • the billing notices (jobs/cloudPlanReminders.ts) — the bell, and ONE daily billing summary email (a table) sent
 *     with the digest.
 * The digest time is the settings' (default 07:00 Nairobi); WATCHDOG_DIGEST_CRON, when set, still fixes it.
 * A check that failed this run (a database error) never "resolves" its alerts — they would be told again as new on the
 * next run. When the database itself is down, what was said is kept in memory, so the outage is told once.
 *
 * A total cloud outage cannot be reported from inside the cloud: .github/workflows/uptime-check.yml (GitHub, every 10
 * minutes) and UptimeRobot watch /health for that. WATCHDOG_ENABLED=false turns it off. Never throws: a failed check is
 * logged and the next run tries again.
 */

const DAY_MS = 24 * 60 * 60_000;
/** A522: how far back an open trading day is still reported (it used to drop out after 3 days). */
const DAYS_NOT_CLOSED_WINDOW = 30;

/** A589: each check and the alert keys it owns — a failed check leaves its open alerts as they are. */
const CHECK_KEYS: Record<string, string[]> = {
  errors: ['server_errors'],
  'sign-ins': ['signin_failures', 'signin_failures_ip'],
  'sync refused': ['sync_refused', 'sync_rows_refused'],
  database: ['database_unreachable'],
  load: ['server_overload'],
  backup: ['backup_missed'],
  pos: ['till_not_syncing', 'till_parked', 'old_tills'],
  'tills signed out': ['till_signed_out'],   // till-wording: ok — a developer's log label
  mpesa: ['mpesa_unanswered'],
  'payment exceptions': ['payment_exception'],
  days: ['day_not_closed'],
  etims: ['etims_failed'],
};
const CLIENT_CHECKS = ['pos', 'tills signed out', 'mpesa', 'payment exceptions', 'days', 'etims'];   // till-wording: ok — developer's check labels
const prefixOf = (key: string) => String(key).split(':')[0];

async function names(): Promise<{ ok: boolean; active: string[]; names: Record<string, string>; approved: Record<string, string | null> }> {
  const { data, error } = await supabase
    .from('businesses')
    .select('id, name, status, suspended_at, desktop_approved_version')
    .eq('status', 'active');
  const rows = ((data ?? []) as any[]).filter((b) => !b.suspended_at);
  return {
    ok: !error,
    active: rows.map((b) => b.id),
    names: Object.fromEntries(rows.map((b) => [b.id, b.name])),
    approved: Object.fromEntries(rows.map((b) => [b.id, b.desktop_approved_version ?? null])),
  };
}

/**
 * A579: for each older till that is on but has not pushed for 2 hours (lib/watchdogRules.ts quietCandidates — normally
 * none or a handful): is a drawer open on it, and what was sold at its branch since its last sync — by it, and by the
 * others (or the web POS)? One shifts read for all, one orders read per till (indexed by branch, at most a day back,
 * capped). A failed read leaves that till without evidence: a warning, never a false critical.
 */
async function tradeEvidence(tills: DeviceRow[], now: Date): Promise<Record<string, TradeEvidence>> {
  const out: Record<string, TradeEvidence> = {};
  const withId = tills.filter((d) => d.device_id);
  if (!withId.length) return out;
  const open = new Set<string>();
  try {
    const { data, error } = await supabase.from('shifts').select('device_id').eq('status', 'open')
      .in('business_id', [...new Set(withId.map((d) => d.business_id))])
      .in('device_id', withId.map((d) => d.device_id as string).slice(0, 500)).limit(1000);
    if (error) throw error;
    for (const r of (data ?? []) as any[]) if (r.device_id) open.add(r.device_id);
  } catch (err: any) { console.error('[watchdog] A579 open drawers read failed:', err?.message ?? err); }
  // A593: ONE orders read per branch (from the earliest of its quiet tills' last syncs), not one per till — each till
  // still counts only its branch's sales since its OWN last sync. A branch with 1,000 sales or more since then: each of
  // its tills is read on its own, as before (the cap must not hide a till's own sale).
  const dayAgo = now.getTime() - DAY_MS;
  const sinceOf = (d: DeviceRow) => new Date(Math.max(d.last_sync_at ? Date.parse(d.last_sync_at) : 0, dayAgo)).toISOString();
  const tally = (ev: TradeEvidence, d: DeviceRow, rows: any[], since: string | null) => {
    for (const o of rows) {
      if (since && !(Date.parse(o.created_at) >= Date.parse(since))) continue;
      if (o.device_id === d.device_id) ev.ownSales = (ev.ownSales ?? 0) + 1;
      else ev.otherSales = (ev.otherSales ?? 0) + 1;
    }
  };
  const first200 = withId.slice(0, 200);
  const byBranch = new Map<string, DeviceRow[]>();
  for (const d of first200) if (d.branch_id) { const k = `${d.business_id}|${d.branch_id}`; byBranch.set(k, [...(byBranch.get(k) ?? []), d]); }
  const branchRows = new Map<string, any[] | null>();
  for (const [k, list] of byBranch) {
    if (list.length < 2) continue;   // one till: its own read below, exactly as before
    const since = list.map(sinceOf).sort()[0];
    try {
      const { data, error } = await supabase.from('orders').select('device_id, created_at')
        .eq('business_id', list[0].business_id).eq('branch_id', list[0].branch_id).gte('created_at', since).limit(1000);
      if (error) throw error;
      branchRows.set(k, (data ?? []).length >= 1000 ? null : (data ?? []) as any[]);
    } catch { branchRows.set(k, null); }
  }
  for (const d of first200) {
    const ev: TradeEvidence = { openShift: open.has(d.device_id as string), otherSales: 0, ownSales: 0 };
    if (d.branch_id) {
      const since = sinceOf(d);
      const together = branchRows.get(`${d.business_id}|${d.branch_id}`);
      if (together) tally(ev, d, together, since);
      else {
        try {
          const { data, error } = await supabase.from('orders').select('device_id')
            .eq('business_id', d.business_id).eq('branch_id', d.branch_id).gte('created_at', since).limit(1000);
          if (error) throw error;
          tally(ev, d, (data ?? []) as any[], null);
        } catch (err: any) { console.error('[watchdog] A579 branch sales read failed:', err?.message ?? err); }
      }
    }
    out[d.id] = ev;
  }
  return out;
}

/** A589: one round trip to the database, bounded — reachable, and how long it took. */
async function dbPing(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const ping = supabase.from('businesses').select('id', { head: true, count: 'exact' }).limit(1);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer in 10 s')), 10_000).unref());
    const { error } = (await Promise.race([ping, timeout])) as Awaited<typeof ping>;
    if (error) return { ok: false, ms: Date.now() - started, error: error.message };
    return { ok: true, ms: Date.now() - started };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - started, error: err?.message ?? String(err) };
  }
}

/** A593: the last good backup the watchdog read, and under which ops-event generation. */
let backupSeen: { gen: number; at: number; lastOk: string | null; any: boolean } | null = null;
/** Test seam. */
export function _forgetBackupSeen(): void { backupSeen = null; }

export interface Collected {
  alerts: Alert[];
  /** The key prefixes whose check failed this run (their open alerts are neither resolved nor re-told). */
  failed: Set<string>;
}

/** Every problem found right now, critical and warning. Each check on its own: one failing never hides the others. */
export async function collectAlerts(now = new Date(), opts: { load?: boolean } = {}): Promise<Collected> {
  const alerts: Alert[] = [];
  const failed = new Set<string>();
  const step = async (label: string, f: () => Promise<Alert[]>) => {
    try { alerts.push(...await f()); } catch (err: any) {
      console.error(`[watchdog] ${label} check failed:`, err?.message ?? err);
      for (const k of CHECK_KEYS[label] ?? []) failed.add(k);
    }
  };

  // A589: the database and the server's load first — the system emergencies.
  const ping = await dbPing();
  await step('database', async () => databaseUnreachable(ping));
  if (opts.load !== false) {
    await step('load', async () => serverOverload({ ...requestLoad(10, now.getTime()), loopLagMs: takeLoopLag(), dbPingMs: ping.ok ? ping.ms : null }));
  } else for (const k of CHECK_KEYS.load) failed.add(k);   // the digest's read: the overload alert stays as it is
  await step('backup', async () => {
    if (!ping.ok) throw new Error('database unreachable');
    // A593: the last good backup, kept while no ops event was stored (routes/ops.ts) — at most 30 minutes; the rule is
    // the clock's (backupMissed decides from it at this run's time). It was 1–2 reads every 10 minutes for a weekly job.
    const kept = backupSeen;
    if (memoEnabled() && kept && kept.gen === opsEventsGen() && now.getTime() >= kept.at && now.getTime() - kept.at < 30 * 60_000) {
      return backupMissed(kept.lastOk, kept.any, now);
    }
    const gen = opsEventsGen();
    const last = await supabase.from('ops_events').select('created_at').eq('kind', 'backup').eq('status', 'ok')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (last.error) throw last.error;
    let any = Boolean(last.data);
    if (!any) {
      const r = await supabase.from('ops_events').select('id').eq('kind', 'backup').limit(1).maybeSingle();
      if (r.error) throw r.error;
      any = Boolean(r.data);
    }
    const lastOk = (last.data as { created_at?: string } | null)?.created_at ?? null;
    backupSeen = { gen, at: now.getTime(), lastOk, any };
    return backupMissed(lastOk, any, now);
  });

  const { ok, active, names: nm, approved } = ping.ok ? await names() : { ok: false, active: [], names: {}, approved: {} };
  const inActive = (r: any) => active.includes(r.business_id);

  await step('errors', async () => { const e = recentErrors(); return errorBurst(e.times, now, e.paths); });
  await step('sign-ins', async () => repeatedSignInFailures(recentSignInFailures(), now));   // A392
  await step('sync refused', async () => {                                                 // A392
    const attempts = recentSyncAttempts();
    const ids = [...new Set(attempts.map((l) => l[l.length - 1]?.deviceId).filter(Boolean))] as string[];
    const tills: Record<string, string> = {};
    if (ids.length && ping.ok) {
      const { data } = await supabase.from('user_devices').select('device_id, terminal_code, device_label').in('device_id', ids.slice(0, 500));
      for (const d of (data ?? []) as any[]) tills[d.device_id] = d.terminal_code || d.device_label || tills[d.device_id];
    }
    return tillSyncRefused(attempts, now, nm, tills);
  });
  if (!ok) {   // A589: the clients could not be read — no client check ran; their open alerts stay as they are
    for (const c of CLIENT_CHECKS) for (const k of CHECK_KEYS[c]) failed.add(k);
    return { alerts, failed };
  }
  if (!active.length) return { alerts, failed };

  // A593: the POS check and the signed-out check read the same rows (every POS not retired of the active clients) — one
  // read for both. If it fails (a cloud before migration 125 has no session_lost_*), each reads its own, as before.
  const POS_COLS = 'id, business_id, branch_id, device_id, device_label, terminal_code, status, retired_at, last_seen_at, last_sync_at, app_version, schema_version';
  let shared: Promise<any[] | null> | null = null;
  const sharedDevices = () => (shared ??= (async () => {
    const { data, error } = await supabase.from('user_devices').select(`${POS_COLS}, session_lost_at, session_lost_reason`)
      .in('business_id', active).is('retired_at', null);
    return error ? null : ((data ?? []) as any[]);
  })().catch(() => null));
  const signedOutShared = async () => {
    const both = await sharedDevices();
    return both ? { data: both.filter((d) => d.session_lost_at != null), error: null } : null;
  };

  await step('pos', async () => {
    const both = await sharedDevices();
    const { data, error } = both ? { data: both, error: null } : await supabase
      .from('user_devices')
      .select(POS_COLS)
      .in('business_id', active)
      .is('retired_at', null);
    if (error) throw error;
    // A581: a business whose cloud plan lapsed past its grace has its tills' sync refused on purpose — not "not syncing".
    const lapsed = await lapsedBusinessIds(now.getTime());
    const devices = ((data ?? []) as any[]).filter(inActive).filter((d) => !lapsed.has(d.business_id));
    // A579: the queue each 1.0.20 till reported, and — for an older till that is on and quiet — whether it traded.
    const queues = syncQueueReports();
    const evidence = await tradeEvidence(quietCandidates(devices, now, queues), now);
    return [...tillsNotSyncing(devices, now, nm, { queues, evidence }), ...tillsWithParkedRecords(devices, now, nm, queues),
      ...oldTills(devices, approved, REQUIRED_DESKTOP_SCHEMA, nm)];
  });

  // A407: tills signed out that could not sign back in — read on their own so a cloud before migration 125 still runs
  // every other check.
  await step('tills signed out', async () => {   // till-wording: ok — a developer's log label
    const { data, error } = (await signedOutShared()) ?? await supabase   // A593: the rows the POS check read
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
      .select('id, business_id, branch_id, device_id, terminal_code, business_date, status')
      .eq('status', 'open')
      // A522: 30 days, not 3 — a day left open on a till that was switched off used to drop out of the alerts silently
      // after three days while it still blocked the till (and the test-data clear). It now stays until it is closed —
      // by the till, from Remote Day Close, or as abandoned there for a dead till.
      .gte('business_date', new Date(now.getTime() - DAYS_NOT_CLOSED_WINDOW * DAY_MS).toISOString().slice(0, 10))
      .limit(1000);
    if (error) throw error;
    // A522: a RETIRED till's open day is not an alert (it is closed as abandoned on Remote Day Close, never by the till).
    // A593: a POS among the not-retired rows already read is not retired — only the others are asked about.
    const joined = new Set(((await sharedDevices()) ?? []).map((d) => d.device_id).filter(Boolean));
    const devIds = [...new Set(((data ?? []) as any[]).map((d) => d.device_id).filter(Boolean))].filter((id) => !joined.has(id));
    const retired = new Set<string>();
    if (devIds.length) {
      const { data: devs } = await supabase.from('user_devices').select('device_id, retired_at').in('device_id', devIds.slice(0, 1000));
      for (const d of (devs ?? []) as any[]) if (d.retired_at) retired.add(d.device_id);
    }
    // A589: the branch's name for the admin's table (a failed read: the POS code alone).
    const branchIds = [...new Set(((data ?? []) as any[]).map((d) => d.branch_id).filter(Boolean))];
    const branchName: Record<string, string> = {};
    if (branchIds.length) {
      const { data: br } = await supabase.from('branches').select('id, name').in('id', branchIds.slice(0, 1000));
      for (const b of (br ?? []) as any[]) branchName[b.id] = b.name;
    }
    const rows: any[] = [];
    // A593: every open day's cut-off in two reads (each day row read one or two before).
    await primeDayCutoffs(((data ?? []) as any[]).filter(inActive).map((d) => ({ businessId: d.business_id, branchId: d.branch_id })));
    for (const d of ((data ?? []) as any[]).filter(inActive)) {
      if (d.device_id && retired.has(d.device_id)) continue;
      const cutoff = await getDayCutoff(d.business_id, d.branch_id);
      if (d.business_date >= businessDateEAT(now, cutoff)) continue;               // today's day: still trading
      const end = Date.parse(businessRangeEAT(d.business_date, d.business_date, cutoff).end) + 1;
      rows.push({ ...d, ends_at: new Date(end).toISOString(), branch_name: branchName[d.branch_id] ?? null });
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

  return { alerts, failed };
}

const OPEN_COLS = 'id, alert_key, severity, business_id, title, detail, first_seen_at, last_notified_at, notify_count';

/**
 * A589: what was said while the database could not be written (its own outage) — kept here, so it is told once and its
 * recovery is told, not "new" every 10 minutes. `mem:` ids; written to the table once it is back.
 */
const memo = new Map<string, OpenAlertRow>();
let lastDbRows: OpenAlertRow[] = [];

async function openAlerts(): Promise<OpenAlertRow[]> {
  try {
    let { data, error } = await supabase
      .from('watchdog_alerts').select(`${OPEN_COLS}, acknowledged_at`).is('resolved_at', null);
    if (error && /acknowledged_at/.test(error.message ?? '')) {      // before migration 119: no mute, the rest works
      ({ data, error } = await supabase.from('watchdog_alerts').select(OPEN_COLS).is('resolved_at', null) as any);
    }
    if (error) throw error;
    lastDbRows = (data ?? []) as OpenAlertRow[];
  } catch (err: any) {
    console.error('[watchdog] open alerts not read — using the last known:', err?.message ?? err);
  }
  const have = new Set(lastDbRows.map((r) => r.alert_key));
  return [...lastDbRows, ...[...memo.values()].filter((m) => !have.has(m.alert_key))];
}

/** For tests: forget what the memory holds. */
export function forgetWatchdogMemory(): void { memo.clear(); lastDbRows = []; }

export interface WatchdogRun { opened: number; reminded: number; resolved: number; emailed: number; notified: number; telegram: boolean }

/** One run: find, compare, store, send (lib/adminAlertPolicy.ts decides who hears what). */
export async function runWatchdog(now = new Date()): Promise<WatchdogRun> {
  const { alerts: current, failed } = await collectAlerts(now);
  const settings = await readAlertSettings(now.getTime());
  const plan = planRun(current, await openAlerts(), now);
  const iso = now.toISOString();
  // A589: a check that failed this run resolves nothing — told again as "new" next run otherwise.
  const resolved = plan.resolved.filter((r) => !failed.has(prefixOf(r.alert_key)));

  const escalated = plan.remind.filter((r) => r.row.severity !== 'critical');   // a warning that became critical: news
  const reminders = plan.remind.filter((r) => r.row.severity === 'critical');
  const routed = routeRun({
    opened: [
      ...plan.opened.filter((a) => a.severity === 'critical').map((a) => ({ alert: a, firstSeenAt: iso })),
      ...escalated.map((r) => ({ alert: r.alert, firstSeenAt: r.row.first_seen_at })),
    ],
    reminders: reminders.map((r) => ({ alert: r.alert, firstSeenAt: r.row.first_seen_at })),
    resolved: resolved.filter((r) => r.last_notified_at).map((r) => ({ key: r.alert_key, title: r.title, first_seen_at: r.first_seen_at, business_id: r.business_id ?? null })),
  }, settings, now, alertLinks());

  // Send: the system emergencies one each (email + Telegram); the client ones a super admin wants at once as ONE email;
  // everything else ONE Telegram message; the bell for every problem told for the first time. A592: each one laid out
  // (Telegram HTML with URL buttons; the email's layout and its plain-text part).
  const emailed = new Set<string>();
  for (const m of routed.instantEach) {
    const r = await notifyRendered(m);
    if (r.email || r.telegram) emailed.add(m.key);
  }
  if (routed.instantGroup) {
    const r = await notifyRendered(routed.instantGroup);
    if (r.email || r.telegram) for (const k of routed.instantGroup.keys) emailed.add(k);
  }
  let telegram = false;
  if (routed.telegramGroup) telegram = (await notifyRendered(routed.telegramGroup, { email: false })).telegram;
  await addAdminNotifications(routed.notifications, now);

  for (const a of plan.opened) {
    const critical = a.severity === 'critical';
    const row = {
      alert_key: a.key, severity: a.severity, business_id: a.businessId, title: a.title, detail: a.detail,
      first_seen_at: iso, last_seen_at: iso,
      // told (the bell, Telegram or email) — so a reminder waits 3 hours; notify_count counts the emails (the portal's "emailed N×")
      last_notified_at: critical ? iso : null, notify_count: emailed.has(a.key) ? 1 : 0,
    };
    const { error } = await supabase.from('watchdog_alerts').insert(row);
    if (error) {
      console.error('[watchdog] could not store alert', a.key, error.message);
      memo.set(a.key, { id: `mem:${a.key}`, alert_key: a.key, severity: a.severity, business_id: a.businessId, title: a.title, detail: a.detail,
        first_seen_at: iso, last_notified_at: row.last_notified_at, notify_count: row.notify_count });
    } else memo.delete(a.key);
  }

  const due = new Set(plan.remind.map((r) => r.row.id));
  // A593: a problem still open with nothing new to store (the same severity, title and detail, no reminder due) only
  // moves last_seen_at — ONE update for all of them, not one per row every 10 minutes.
  const seenOnly: string[] = [];
  for (const { row, alert } of plan.stillOpen) {
    const patch: Record<string, unknown> = { last_seen_at: iso, severity: alert.severity, title: alert.title, detail: alert.detail };
    if (!row.id.startsWith('mem:') && !due.has(row.id) && row.severity === alert.severity && row.title === alert.title
        && (row.detail ?? null) === (alert.detail ?? null)) { seenOnly.push(row.id); continue; }
    if (due.has(row.id)) {
      patch.last_notified_at = iso;
      patch.notify_count = (row.notify_count ?? 0) + (emailed.has(alert.key) ? 1 : 0);
    }
    if (row.id.startsWith('mem:')) {
      // A589: told while the database was down — now written, if it is back.
      const m = memo.get(row.alert_key);
      const { error } = await supabase.from('watchdog_alerts').insert({
        alert_key: row.alert_key, business_id: row.business_id ?? null, first_seen_at: row.first_seen_at,
        last_notified_at: (patch.last_notified_at as string | undefined) ?? row.last_notified_at ?? null,
        notify_count: (patch.notify_count as number | undefined) ?? row.notify_count ?? 0, ...patch,
      });
      if (!error) memo.delete(row.alert_key);
      else if (m) memo.set(row.alert_key, { ...m, ...(patch as Partial<OpenAlertRow>) });
      continue;
    }
    const { error } = await supabase.from('watchdog_alerts').update(patch).eq('id', row.id);
    if (error) console.error('[watchdog] could not update alert', row.alert_key, error.message);
  }
  for (let i = 0; i < seenOnly.length; i += 150) {
    const { error } = await supabase.from('watchdog_alerts').update({ last_seen_at: iso }).in('id', seenOnly.slice(i, i + 150));
    if (error) console.error('[watchdog] could not move last_seen_at of', seenOnly.length, 'open alerts:', error.message);
  }

  for (const row of resolved) {
    if (row.id.startsWith('mem:')) { memo.delete(row.alert_key); continue; }
    const { error } = await supabase.from('watchdog_alerts').update({ resolved_at: iso }).eq('id', row.id);
    if (error) console.error('[watchdog] could not resolve alert', row.alert_key, error.message);
  }

  return { opened: plan.opened.length, reminded: plan.remind.length, resolved: resolved.length, emailed: emailed.size,
    notified: routed.notifications.length, telegram };
}

/**
 * The morning digest: everything still open (critical first), then the counters since the last digest — to Telegram as
 * before, and (A589) ONE email with the open problems as a table (client | branch / POS | problem | since). Nothing open
 * = no email.
 */
export async function sendDigest(now = new Date()): Promise<{ emailed: boolean; rows: number }> {
  const settings = await readAlertSettings(now.getTime());
  const open = await openAlerts();
  open.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  const counters = digestCounters(true);
  const links = alertLinks();
  // The rows as each rule words them now ("Day Fri 9 Oct still open (ended 16 days ago)"), else from the stored title.
  let current = new Map<string, Alert>();
  if (open.length) {
    try { current = new Map((await collectAlerts(now, { load: false })).alerts.map((a) => [a.key, a])); } catch { /* the titles */ }
  }
  const rows: DigestRow[] = open.map((r) => ({
    severity: r.severity,
    ...problemFacts(current.get(r.alert_key) ?? { title: r.title, business_id: r.business_id ?? null, key: r.alert_key }, r.first_seen_at, now),
  }));
  // A584: ZapTill's billing lines — every locked client each morning (the client hears nothing), the unpaid ones and when
  // they lock, and how many have no expiry set.
  const billing = await billingDigestLines(now.getTime()).catch(() => [] as string[]);
  // A392: the digest goes to Telegram (and the admin portal's Alerts page). A592: one line per problem, grouped by
  // severity, at most 15 and then "+N more in the admin portal", with a button.
  const tg = digestTelegram(rows, counters, now, billing, links);
  await notifyRendered(tg, { email: false });

  // A589: the email — ONE table per severity.
  if (!settings.digestEmail || !open.length) return { emailed: false, rows: open.length };
  const mail = digestEmail(rows, counters, now, links);
  if (!mail) return { emailed: false, rows: 0 };
  const sent = await notifyRendered({ ...tg, subject: mail.subject, html: mail.html, emailText: mail.text }, { telegram: false });
  return { emailed: sent.email, rows: rows.length };
}

/**
 * A589: ONE daily email of ZapTill's billing notices (the bell's 'billing' rows not yet in a summary) and the clients
 * still unpaid or locked — a table: client | invoice | amount | due | status. Sent with the digest; nothing to say = none.
 */
export async function sendBillingSummary(now = new Date()): Promise<{ emailed: boolean; rows: number }> {
  const settings = await readAlertSettings(now.getTime());
  if (!settings.billingSummaryEmail) return { emailed: false, rows: 0 };
  const { data, error } = await supabase.from('admin_notifications').select('id, title, data, created_at')
    .eq('category', 'billing').is('digest_sent_at', null)
    .gte('created_at', new Date(now.getTime() - 7 * DAY_MS).toISOString())
    .order('created_at', { ascending: true }).limit(500);
  if (error) console.warn('[watchdog] billing notices not read (migration 174?):', error.message);
  const list = (error ? [] : (data ?? [])) as Array<{ id: string; title: string; data: Record<string, any> | null }>;
  const notices: BillingRow[] = list.map((n) => {
    const d = n.data ?? {};
    return { client: String(d.client ?? n.title), invoice: d.invoice ?? null, amount: typeof d.amount === 'number' ? d.amount : null,
      currency: String(d.currency ?? 'KES'), due: d.due ?? null, status: String(d.status ?? n.title) };
  });
  const standing = await billingStandingRows(now.getTime());
  const mail = billingSummaryEmail(notices, standing, now, alertLinks());
  if (!mail) return { emailed: false, rows: 0 };
  const sent = await notifyRendered({ subject: mail.subject, text: mail.text, tgHtml: '', buttons: [], html: mail.html, emailText: mail.text }, { telegram: false });
  if (sent.email && list.length) {
    const { error: uErr } = await supabase.from('admin_notifications').update({ digest_sent_at: now.toISOString() }).in('id', list.map((n) => n.id));
    if (uErr) console.warn('[watchdog] billing notices not marked as summarised:', uErr.message);
  }
  return { emailed: sent.email, rows: notices.length + standing.length };
}

/** The morning: the digest, then the billing summary. */
export async function sendMorning(now = new Date()): Promise<void> {
  try { await sendDigest(now); } catch (err: any) { console.error('[watchdog] digest failed:', err?.message ?? err); }
  try { await sendBillingSummary(now); } catch (err: any) { console.error('[watchdog] billing summary failed:', err?.message ?? err); }
}

/** A589: is the digest due now (the settings' time, once a Nairobi day)? If so, claimed — the caller sends it. */
export async function claimDigest(now = new Date()): Promise<boolean> {
  const s = await readAlertSettings(now.getTime());
  if (!digestDue(now, s.digestTime, await readDigestDate())) return false;
  await writeDigestDate(nairobiClock(now).date);
  return true;
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
  startLoopMonitor();   // A589: the overload signal
  let running = false;
  const schedule = process.env.WATCHDOG_CRON ?? '*/10 * * * *';
  cron.schedule(schedule, meterJob('watchdog', async () => {
    if (running) return;                                   // a slow run never overlaps the next
    running = true;
    try {
      const r = await runWatchdog();
      if (r.opened || r.reminded || r.resolved) console.log(`[watchdog] new ${r.opened}, reminded ${r.reminded}, resolved ${r.resolved}, emailed ${r.emailed}`);
    } catch (err: any) {
      console.error('[watchdog] run failed:', err?.message ?? err);
    } finally {
      running = false;
    }
  }, { quietWrites: true }), { timezone: 'UTC' });   // A593: its writes are its own (watchdog_alerts, the bell) — no POS answer holds them

  // A589: the digest at the settings' time (default 07:00 Nairobi), checked every 5 minutes; WATCHDOG_DIGEST_CRON fixes it.
  const fixed = process.env.WATCHDOG_DIGEST_CRON;
  let morning = false;
  if (fixed) {
    cron.schedule(fixed, meterJob('watchdogMorning', () => { void sendMorning(); }, { quietWrites: true }), { timezone: 'Africa/Nairobi' });
  } else {
    cron.schedule('*/5 * * * *', meterJob('watchdogDigest', async () => {
      if (morning) return;
      morning = true;
      try { if (await claimDigest()) await sendMorning(); }
      catch (err: any) { console.error('[watchdog] digest check failed:', err?.message ?? err); }
      finally { morning = false; }
    }, { quietWrites: true }), { timezone: 'UTC' });
  }
  console.log(`[watchdog] Scheduled: checks ${schedule} UTC, digest ${fixed ? `${fixed} Africa/Nairobi` : 'at the admin settings\' time (default 07:00 Nairobi)'} — Telegram ${ch.telegram ? 'on' : 'off'}, email ${ch.email ? 'on' : 'off'}`);
}
