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
import { meterJob } from '../lib/supabaseMeter';   // A591: this job's Supabase calls, counted
import { writeGen, memoEnabled } from '../lib/writeActivity';   // A591
import { traffic } from '../lib/trafficStats';   // A591
import cron from 'node-cron';
// A478: formatInTimeZone CONVERTS to EAT; date-fns-tz's format(…, { timeZone }) only labels the machine's local time — on
// Render (UTC) the 21:00 / 09:00 / Monday 08:00 / 1st-07:00 sends ran three hours late. A Nairobi-time PC hid it.
import { formatInTimeZone } from 'date-fns-tz';
const tzFormat = (d: Date, fmt: string, o: { timeZone: string }) => formatInTimeZone(d, o.timeZone, fmt);
import { supabase } from '../lib/supabase';
import { sendEmail } from '../lib/mailer';
import { standingFor, primeStandings } from '../lib/cloudPlan';   // A581 (A593: primeStandings)
import { getDayCutoff, primeDayCutoffs } from '../lib/dayCutoff';   // A593: primeDayCutoffs
import { pageAll } from '../lib/pgQuery';   // A593
import { businessDateEAT, businessRangeEAT } from '@zaptill/core/businessDay';
import { readReportSchedule, gatherRecipients, readSettingsFor, parseReportSchedule, type SettingsRows } from './dailySummary';   // A593: the tick's reads
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
  cron.schedule(schedule, meterJob('ownerAlerts', async () => {
    try { await runOwnerAlertsTick(new Date()); } catch (err: any) { console.error('[ownerAlerts] Job failed:', err?.message); }
  }, { quietWrites: true }), { timezone: 'UTC' });   // A591: its writes are its own stamps (business_settings) and emails
  console.log(`[ownerAlerts] Scheduled: ${schedule} (branch tills, alerts, weekly summary)`);
}

// ── settings rows ────────────────────────────────────────────────────────────

async function readSetting(businessId: string, key: string): Promise<unknown> {
  const t = tickSetting(businessId, key);   // A593
  if (t) return t.row?.value ?? null;
  const { data, error } = await supabase.from('business_settings').select('value')
    .eq('business_id', businessId).eq('key', key).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

async function writeSetting(businessId: string, key: string, value: unknown): Promise<void> {
  // A593: the tick already read this row (or knows there is none) — no second read to find it.
  const t = tickSetting(businessId, key);
  tick?.dirty.add(`${businessId}|${key}`);
  const found = t ? { data: t.row ? { id: t.row.id } : null, error: null } : await supabase.from('business_settings').select('id')
    .eq('business_id', businessId).eq('key', key).maybeSingle();
  const { data: existing, error: rErr } = found;
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
  try { await startTick((businesses ?? []) as Biz[], now); } catch { tick = null; }   // A593
  try {
  for (const biz of (businesses ?? []) as Biz[]) {
    let schedule: any;
    const pre = tickSetting(biz.id, 'report_schedule');   // A593
    try { schedule = pre ? parseReportSchedule(pre.row) : await readReportSchedule(biz.id); } catch (e: any) { console.error(`[ownerAlerts] ${biz.name}: schedule:`, e?.message); continue; }
    for (const [name, step] of [
      ['branch points of sale', () => branchOpenTillsForBusiness(biz, schedule, now)],
      ['alerts', () => alertsForBusiness(biz, schedule, now)],
      ['weekly', () => weeklyForBusiness(biz, schedule, now)],
    ] as const) {
      try { await step(); } catch (e: any) { console.error(`[ownerAlerts] ${name} failed for ${biz.name} (${biz.id}):`, e?.message); }
    }
  }
  } finally { tick = null; }
}

// ── A593: one tick's reads for every business at once ───────────────────────────────────────────────────────────────
/**
 * Owner, 2026-10-26 (the System page: job:ownerAlerts 375 Supabase calls in 5 runs — "logs are full already"): every run
 * read, per business, its schedule, its alert state, its branches (twice), its branch stamps, its cut-off and its tills
 * and open drawers. Now the tick reads them for EVERY business at once — the settings rows in one read, the branches in
 * one, the cut-offs in one, the tills and the open drawers in one each when a business needs them — and each business is
 * decided from those rows exactly as from its own reads. A read that fails, or a key held twice (the single read refuses
 * it): that business reads its own, as before. A business's steps called on their own (the tests) read as before.
 */
interface Tick {
  ids: string[];
  settings: SettingsRows | null;
  keys: Set<string>;
  dirty: Set<string>;
  branches: Map<string, Map<string, string>> | null;
  devices?: Promise<Map<string, any[]> | null>;
  open?: Promise<Map<string, string[]> | null>;
  rows?: Map<string, Promise<Map<string, any[]> | null>>;
}
let tick: Tick | null = null;

/** The row the tick read for (business, key): { row } (null: none), or undefined — read it as before. */
function tickSetting(businessId: string, key: string): { row: { id: string; value: unknown } | null } | undefined {
  if (!tick?.settings || !tick.keys.has(key) || tick.dirty.has(`${businessId}|${key}`) || !tick.ids.includes(businessId)) return undefined;
  const rows = tick.settings.get(`${businessId}|${key}`) ?? [];
  return rows.length > 1 ? undefined : { row: rows[0] ?? null };
}

/** Every row of `build(chunk)` for the ids, 150 a read, page by page. */
async function pagedIn<T>(ids: string[], build: (chunk: string[]) => any): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    out.push(...await pageAll<T>(() => build(chunk), 1000));
  }
  return out;
}

async function startTick(businesses: Biz[], now: Date): Promise<void> {
  const ids = businesses.map((b) => b.id);
  const t: Tick = { ids, settings: null, keys: new Set(), dirty: new Set(), branches: null };
  try {
    const rows = await pagedIn<{ id: string; business_id: string; name: string | null }>(ids, (c) => supabase.from('branches').select('id, business_id, name').in('business_id', c));
    const by = new Map<string, Map<string, string>>();
    for (const r of rows) {
      const m = by.get(r.business_id) ?? new Map<string, string>();
      if (m.size < 1000) m.set(r.id, r.name ?? 'Branch');   // as branchNames' limit(1000)
      by.set(r.business_id, m);
    }
    t.branches = by;
  } catch { t.branches = null; }
  const keys = ['report_schedule', ALERT_STATE_KEY, WEEKLY_KEY,
    ...(t.branches ? [...t.branches.values()].flatMap((m) => [...m.keys()].map((id) => `${BRANCH_TILLS_KEY}${id}`)) : [])];
  t.settings = await readSettingsFor(ids, keys);
  if (t.settings) for (const k of keys) t.keys.add(k);
  await primeDayCutoffs(ids.map((id) => ({ businessId: id })), now.getTime());
  await primeStandings(ids).catch(() => { /* each reads its own */ });   // the plan standing: one read set for all
  tick = t;
}

/** The tick's tills of every business (loadDevices' rows), read once when the first business needs them. */
function tickDevices(): Promise<Map<string, any[]> | null> | null {
  if (!tick) return null;
  return (tick.devices ??= (async () => {
    const base = 'id, business_id, device_id, branch_id, device_label, terminal_code, status, retired_at, last_seen_at, last_sync_at, app_version';
    try {
      const rows = await pagedIn<any>(tick!.ids, (c) => supabase.from('user_devices')
        .select(`${base}, session_lost_at, session_lost_reason, security_alert_at, security_alert_reason`).in('business_id', c).eq('status', 'approved').is('retired_at', null));
      const by = new Map<string, any[]>();
      for (const r of rows) { const list = by.get(r.business_id) ?? []; if (list.length < 500) { const { business_id: _b, ...d } = r; list.push(d); } by.set(r.business_id, list); }
      return by;
    } catch { return null; }
  })());
}
/** The tick's open drawers' branches of every business, read once when the first business needs them. */
function tickOpen(): Promise<Map<string, string[]> | null> | null {
  if (!tick) return null;
  return (tick.open ??= (async () => {
    try {
      const rows = await pagedIn<{ business_id: string; branch_id: string | null }>(tick!.ids, (c) => supabase.from('shifts').select('id, business_id, branch_id').in('business_id', c).eq('status', 'open'));
      const by = new Map<string, string[]>();
      for (const r of rows) { const list = by.get(r.business_id) ?? []; if (list.length < 500 && r.branch_id) list.push(r.branch_id); by.set(r.business_id, list); }
      return by;
    } catch { return null; }
  })());
}
/** A593: ORDER BY col ASC LIMIT n, as the single read did (ties by id, so the cut is stable). */
function firstByTime(rows: any[], col: string, n: number): any[] {
  return [...rows].sort((a, b) => (Date.parse(a[col]) - Date.parse(b[col])) || String(a.id).localeCompare(String(b.id))).slice(0, n);
}
/**
 * A593: the tick's voids and refunds (orders voided or refunded since) or confirmed drawers (shifts confirmed since) of
 * EVERY business, read once when the first business needs them; each business then filters its own by its own amount.
 * 50,000 rows or a failed read: null — each business reads its own, as before.
 */
function tickRows(kind: 'reversals' | 'confirmed', since: string): Promise<Map<string, any[]> | null> | null {
  if (!tick) return null;
  const t = tick;
  const key = `${kind}|${since}`;
  t.rows ??= new Map();
  if (!t.rows.has(key)) t.rows.set(key, (async () => {
    try {
      const rows = kind === 'reversals'
        ? [...await pagedIn<any>(t.ids, (c) => supabase.from('orders').select('id, business_id, status, order_number, total, void_reason, cashier_id, voided_by, authorized_by, branch_id, voided_at, created_at, refunded_amount, refund_reason, refunded_by, refund_authorized_by, refunded_at')
            .in('business_id', c).eq('status', 'voided').gte('voided_at', since)),
           ...await pagedIn<any>(t.ids, (c) => supabase.from('orders').select('id, business_id, status, order_number, total, void_reason, cashier_id, voided_by, authorized_by, branch_id, voided_at, created_at, refunded_amount, refund_reason, refunded_by, refund_authorized_by, refunded_at')
            .in('business_id', c).not('refunded_at', 'is', null).gte('refunded_at', since))]
        : await pagedIn<any>(t.ids, (c) => supabase.from('shifts').select('id, business_id, branch_id, cashier_id, device_id, terminal_code, expected_methods, confirmed_methods, cash_variance, confirm_reasons, confirmed_at, confirmed_by')
            .in('business_id', c).gte('confirmed_at', since));
      if (rows.length >= 50_000) return null;
      const by = new Map<string, any[]>();
      const seen = new Set<string>();
      for (const r of rows) {
        const k = `${r.business_id}|${r.id}`;
        if (kind === 'reversals' && seen.has(k)) continue;   // voided AND refunded: one row (each list filters its own)
        seen.add(k);
        const { business_id: b, ...row } = r;
        by.set(b, [...(by.get(b) ?? []), row]);
      }
      return by;
    } catch { return null; }
  })());
  return t.rows.get(key)!;
}

async function branchesOf(businessId: string): Promise<Map<string, string>> {
  if (tick?.branches && tick.ids.includes(businessId)) return new Map(tick.branches.get(businessId) ?? []);
  return branchNames(businessId);
}


// ── 1. branch managers: tills not closed (always) ────────────────────────────

export async function branchOpenTillsForBusiness(biz: Biz, schedule: { send_time?: string }, now: Date): Promise<number> {
  const nowDate = tzFormat(now, 'yyyy-MM-dd', { timeZone: EAT });
  const nowHHMM = tzFormat(now, 'HH:mm', { timeZone: EAT });
  // cheap exit: no slot can be due before the earlier of 09:00 and send_time
  if (!decideBranchSlot(nowDate, nowHHMM, schedule.send_time, null)) return 0;

  const branches = await branchesOf(biz.id);   // A593: the tick's read when it has one
  if (!branches.size) return 0;
  const keys = [...branches.keys()].map((id) => `${BRANCH_TILLS_KEY}${id}`);
  let last: Map<string, string | null>;
  if (keys.every((k) => tick?.settings && tick.keys.has(k) && !tick.dirty.has(`${biz.id}|${k}`)) && tick?.ids.includes(biz.id)) {
    last = new Map(keys.flatMap((k) => (tick!.settings!.get(`${biz.id}|${k}`) ?? []).map((r) => [k, asText(r.value)] as [string, string | null])));
  } else {
    const { data: stamps, error } = await supabase.from('business_settings').select('key, value')
      .eq('business_id', biz.id).in('key', keys);
    if (error) throw new Error(error.message);
    last = new Map(((stamps ?? []) as any[]).map((r) => [r.key, asText(r.value)]));
  }

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
  const branches = await branchesOf(biz.id);   // A593
  let sent = 0;
  // A591: the big-void and variance checks read 48 h of voids, refunds and confirmed drawers every 15 minutes. While
  // nothing was written for the business (lib/writeActivity.ts) since a read that left nothing to tell, the same read
  // finds the same nothing: skipped. Read again at least every 6 h. The not-syncing check (time decides it) always runs.
  const gen = writeGen(biz.id);
  const q = ownerQuiet.get(biz.id);
  const unchanged = memoEnabled() && !seeding && !!q && q.gen === gen;
  const skipVoids = unchanged && q!.voidsAt > 0 && now.getTime() - q!.voidsAt < OWNER_QUIET_MAX_MS;
  const skipVariance = unchanged && q!.varianceAt > 0 && now.getTime() - q!.varianceAt < OWNER_QUIET_MAX_MS;
  let voidsAt = skipVoids ? q!.voidsAt : 0;
  let devicesSeen: OwnerQuiet['devices'] = null;
  let varianceAt = skipVariance ? q!.varianceAt : 0;

  if (s.alert_not_syncing) {
    // A591: the tills' rows and the open drawers change only by a write (a till's sync or heartbeat comes through this
    // server); the decision is the clock's. While nothing was written since they were read (at most 6 h), the same rows
    // are decided again at this run's time — no read. A till left on sends its heartbeat every 15 minutes, so a trading
    // business is read every run, as before; a closed shop overnight is not.
    const seen = unchanged && q!.devices && now.getTime() - q!.devices.at < OWNER_QUIET_MAX_MS ? q!.devices : null;
    let devices: Awaited<ReturnType<typeof loadDevices>>;
    let openBranches: string[];
    if (seen) { devices = seen.rows; openBranches = seen.open; traffic.count('owner_alerts.devices_from_memory'); }
    else {
      // A593: the tick's one read of every business's tills and open drawers, when it has them.
      const allDevices = await tickDevices();
      const allOpen = await tickOpen();
      devices = allDevices ? (allDevices.get(biz.id) ?? []) as Awaited<ReturnType<typeof loadDevices>> : await loadDevices(biz.id);
      if (allOpen) openBranches = allOpen.get(biz.id) ?? [];
      else {
        const { data: open, error } = await supabase.from('shifts').select('branch_id')
          .eq('business_id', biz.id).eq('status', 'open').limit(500);
        if (error) throw new Error(error.message);
        openBranches = ((open ?? []) as any[]).map((r) => r.branch_id).filter(Boolean) as string[];
      }
    }
    const trading = new Set(openBranches);
    let managers: Awaited<ReturnType<typeof branchManagerEmails>> | null = null;
    const next: Record<string, string> = {};
    // A581: the cloud plan lapsed past its grace — the cloud refuses the tills' sync on purpose; the owner hears it from the
    // plan's reminders, never as "till not syncing".
    // (not remembered: a grace period runs out by the clock, with no write)
    // A601: and a desktop-only business from the cut-off — its POSs send no backup on purpose.
    const planStanding = await standingFor(biz.id).catch(() => null);
    const planLapsed = planStanding?.syncRefused === true || planStanding?.desktopOnly?.backupOff === true;
    devicesSeen = seen ?? { rows: devices, open: openBranches, at: now.getTime() };
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
      if (planLapsed) continue;
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

  if (s.alert_big_void && skipVoids) traffic.count('owner_alerts.voids_skipped');
  if (s.alert_big_void && !skipVoids) {
    // A593: the tick's one read of every business's voids and refunds since, when it has it (the same rows, the same order).
    const all = await tickRows('reversals', since);
    const [v, r] = all ? [
      { data: firstByTime((all.get(biz.id) ?? []).filter((o) => o.status === 'voided' && o.voided_at && Date.parse(o.voided_at) >= Date.parse(since) && Number(o.total) >= s.big_void_amount), 'voided_at', 200), error: null },
      { data: firstByTime((all.get(biz.id) ?? []).filter((o) => o.refunded_at && Date.parse(o.refunded_at) >= Date.parse(since) && Number(o.refunded_amount) >= s.big_void_amount), 'refunded_at', 200), error: null },
    ] : await Promise.all([
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
      if (delivered) voidsAt = now.getTime();
    } else voidsAt = now.getTime();
  }

  if (s.alert_variance && skipVariance) traffic.count('owner_alerts.variance_skipped');
  if (s.alert_variance && !skipVariance) {
    const allConfirmed = await tickRows('confirmed', since);   // A593: the tick's one read, when it has it
    const { data, error } = allConfirmed ? { data: firstByTime(allConfirmed.get(biz.id) ?? [], 'confirmed_at', 500), error: null } : await supabase.from('shifts')
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
      if (delivered) varianceAt = now.getTime();
    } else varianceAt = now.getTime();
  }

  state.sent = pruneSent(state.sent, now);
  state.seeded = true;
  if (JSON.stringify(state) !== before) await writeSetting(biz.id, ALERT_STATE_KEY, state);
  ownerQuiet.set(biz.id, { gen, voidsAt, varianceAt, devices: devicesSeen });
  return sent;
}

/** A591: per business, the write generation and when the void and variance checks last read and left nothing to tell. */
interface OwnerQuiet { gen: string; voidsAt: number; varianceAt: number; devices: { rows: any[]; open: string[]; at: number } | null }
const ownerQuiet = new Map<string, OwnerQuiet>();
export const OWNER_QUIET_MAX_MS = 6 * 3_600_000;
/** Test seam. */
export function _resetOwnerQuiet(): void { ownerQuiet.clear(); }

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
