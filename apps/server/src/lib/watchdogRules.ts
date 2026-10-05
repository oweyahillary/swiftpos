/**
 * watchdogRules.ts — A383: what the cloud's watchdog calls a problem, and when it tells the admin (A383).
 *
 * Owner, 2026-10-03: "as an admin is there a way i can be getting this errors critical one first hand before the client
 * calls like an email notification or something proactive not reactive" — "telegram and email combo is fine".
 *
 * PURE: no database, no network, no clock (every rule takes `now`). jobs/watchdog.ts reads the rows, runs these rules,
 * remembers what it already said (public.watchdog_alerts, migration 116) and sends (lib/alertNotify.ts).
 *
 *   CRITICAL — told at once, reminded every REMIND_MIN while it lasts, "resolved" when it clears:
 *     • a till that is ON (seen in the last 30 min) but has not synced for 2 hours — its sales are not reaching the cloud;
 *     • M-Pesa requests with no answer from Safaricom after 10 minutes (2 or more in 2 hours) — the callback is broken;
 *     • an M-Pesa payment that did not match (payment_exceptions, unresolved);
 *     • a burst of server errors (10 or more 5xx in 5 minutes);
 *     • a trading day still open 3 hours after its business day ended (the owner's cut-off, 0.6.34).
 *     • A392: repeated failed sign-ins — one account 8+ times in 15 min (an admin account: 5+), or one address 20+;
 *     • A392: a till the cloud keeps refusing — 3+ pushes refused in 30 min and none taken (licence, branch, a revoked
 *       till, an old build), or rows refused on their merits in the last hour (they will not be retried).
 *   Only CRITICAL problems are emailed (owner, 2026-10-04: "all alerts emails should only get critical failures … others
 *   put in the admin"): new and still-happening. "Resolved" and the digest go to Telegram and the admin portal's Alerts.
 *   WARNING — in the morning digest and the admin portal only:
 *     • tills on an older version or local schema; one M-Pesa request unanswered; eTIMS invoices that failed;
 *     • the counters: write-guard blocks (A159) and failed sign-ins since the last digest.
 */

export type Severity = 'critical' | 'warning';

export interface Alert {
  /** What the problem IS — the same problem keeps the same key from run to run (dedupe). */
  key: string;
  severity: Severity;
  businessId: string | null;
  title: string;
  detail: string;
}

export const WATCHDOG = {
  SIGNIN_WINDOW_MIN: 15,
  SIGNIN_ACCOUNT: 8,
  SIGNIN_ADMIN_ACCOUNT: 5,
  SIGNIN_IP: 20,
  SYNC_WINDOW_MIN: 30,
  SYNC_FAILS: 3,
  SYNC_ROWS_WINDOW_MIN: 60,
  SEEN_RECENT_MIN: 30,
  SYNC_STALE_MIN: 120,
  MPESA_STUCK_MIN: 10,
  MPESA_WINDOW_MIN: 120,
  MPESA_CRITICAL_COUNT: 2,
  ERROR_BURST: 10,
  ERROR_WINDOW_MIN: 5,
  DAY_GRACE_MIN: 180,
  REMIND_MIN: 180,
} as const;

const MIN = 60_000;
const ms = (t: string | null | undefined) => (t ? Date.parse(t) : NaN);
const ago = (now: Date, t: string | null | undefined) => (now.getTime() - ms(t)) / MIN;

/** "2 h 15 min" / "45 min". */
export function durationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** -1 / 0 / 1 for "a.b.c" versions; anything not a version sorts first (treated as old). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const ok = (v: unknown) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
  if (!ok(a) && !ok(b)) return 0;
  if (!ok(a)) return -1;
  if (!ok(b)) return 1;
  const pa = (a as string).split('.').map(Number), pb = (b as string).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export interface DeviceRow {
  id: string;
  business_id: string;
  device_label?: string | null;
  terminal_code?: string | null;
  status?: string | null;
  retired_at?: string | null;
  last_seen_at?: string | null;
  last_sync_at?: string | null;
  app_version?: string | null;
  schema_version?: number | null;
  /** A407 (migration 125): its session was refused and it could not sign itself back in. */
  session_lost_at?: string | null;
  session_lost_reason?: string | null;
}

const tillName = (d: DeviceRow) => d.terminal_code || d.device_label || `till ${String(d.id).slice(0, 8)}`;
const live = (d: DeviceRow) => !d.retired_at && (d.status ?? 'approved') === 'approved';

/**
 * CRITICAL (A407): a till whose sign-in the cloud refused and that could not sign itself back in with its device
 * secret. Owner, 2026-10-05: "if a till is rejected when it comes online after a long offline period i should get an
 * email". It keeps selling on its own PIN check, but its sales wait on it until someone brings a new enrolment code.
 */
export function tillsSignedOut(devices: DeviceRow[], now: Date, names: Record<string, string> = {}): Alert[] {
  const out: Alert[] = [];
  for (const d of devices) {
    if (!live(d) || !d.session_lost_at) continue;
    out.push({
      key: `till_signed_out:${d.id}`,
      severity: 'critical',
      businessId: d.business_id,
      title: `${names[d.business_id] ?? 'A client'}: ${tillName(d)} is signed out and could not sign back in`,
      detail: `Since ${durationLabel(ago(now, d.session_lost_at))} ago${d.session_lost_reason ? ` — ${d.session_lost_reason}` : ''}. `
        + `It keeps selling on its own, but its sales wait on the till. Issue an enrolment code (client › Branches & tills) `
        + `and enter it on the till (Sign out / switch account).`,
    });
  }
  return out;
}

/** CRITICAL: the till is switched on and talking to the cloud, but its sales have not synced for 2 hours. */
export function tillsNotSyncing(devices: DeviceRow[], now: Date, names: Record<string, string> = {}): Alert[] {
  const out: Alert[] = [];
  for (const d of devices) {
    if (!live(d) || !d.last_seen_at) continue;
    if (ago(now, d.last_seen_at) > WATCHDOG.SEEN_RECENT_MIN) continue;      // off / offline — not this rule
    const stale = d.last_sync_at ? ago(now, d.last_sync_at) : Infinity;
    if (!(stale > WATCHDOG.SYNC_STALE_MIN)) continue;
    out.push({
      key: `till_not_syncing:${d.id}`,
      severity: 'critical',
      businessId: d.business_id,
      title: `${names[d.business_id] ?? 'A client'}: ${tillName(d)} is on but not syncing`,
      detail: d.last_sync_at
        ? `Last sync ${durationLabel(stale)} ago (seen ${durationLabel(ago(now, d.last_seen_at))} ago). Its sales are not reaching the cloud.`
        : `It has never synced (seen ${durationLabel(ago(now, d.last_seen_at))} ago).`,
    });
  }
  return out;
}

export interface MpesaRow { id: string; business_id: string; status: string; mpesa_requested_at: string | null; amount?: number | string | null }

/**
 * M-Pesa requests with no answer: still 'pending' 10 minutes after the STK push (Safaricom answers within ~60 s, a
 * cancel included). 2+ in the last 2 hours at one client = CRITICAL (the callback is not reaching us); one = WARNING.
 */
export function mpesaUnanswered(rows: MpesaRow[], now: Date, names: Record<string, string> = {}): Alert[] {
  const per = new Map<string, MpesaRow[]>();
  for (const r of rows) {
    if (r.status !== 'pending' || !r.mpesa_requested_at) continue;
    const age = ago(now, r.mpesa_requested_at);
    if (age < WATCHDOG.MPESA_STUCK_MIN || age > WATCHDOG.MPESA_WINDOW_MIN) continue;
    per.set(r.business_id, [...(per.get(r.business_id) ?? []), r]);
  }
  return [...per].map(([biz, list]) => {
    const critical = list.length >= WATCHDOG.MPESA_CRITICAL_COUNT;
    return {
      key: `mpesa_unanswered:${biz}`,
      severity: critical ? 'critical' : 'warning',
      businessId: biz,
      title: `${names[biz] ?? 'A client'}: ${list.length} M-Pesa payment${list.length === 1 ? '' : 's'} with no answer from Safaricom`,
      detail: `${list.length} request${list.length === 1 ? '' : 's'} in the last ${durationLabel(WATCHDOG.MPESA_WINDOW_MIN)} got no callback after `
        + `${WATCHDOG.MPESA_STUCK_MIN} min.${critical ? ' Check the M-Pesa callback URL and Daraja keys.' : ''}`,
    } as Alert;
  });
}

export interface ExceptionRow { id: string; business_id: string; reason: string; resolved_at?: string | null; created_at: string; expected_amount?: number | string | null; received_amount?: number | string | null }

/** CRITICAL: an M-Pesa payment that did not match what was asked (payment_exceptions), not yet resolved. One per client. */
export function paymentExceptions(rows: ExceptionRow[], names: Record<string, string> = {}): Alert[] {
  const per = new Map<string, ExceptionRow[]>();
  for (const r of rows) if (!r.resolved_at) per.set(r.business_id, [...(per.get(r.business_id) ?? []), r]);
  return [...per].map(([biz, list]) => ({
    key: `payment_exception:${biz}`,
    severity: 'critical' as Severity,
    businessId: biz,
    title: `${names[biz] ?? 'A client'}: ${list.length} M-Pesa payment${list.length === 1 ? '' : 's'} to review`,
    detail: list.slice(0, 3).map((r) => r.reason).join('; ') + (list.length > 3 ? '; …' : ''),
  }));
}

/** CRITICAL: 10+ server errors (5xx) in the last 5 minutes — the whole cloud, not one client. */
export function errorBurst(errorTimes: number[], now: Date, paths: string[] = []): Alert[] {
  const since = now.getTime() - WATCHDOG.ERROR_WINDOW_MIN * MIN;
  const n = errorTimes.filter((t) => t >= since && t <= now.getTime()).length;
  if (n < WATCHDOG.ERROR_BURST) return [];
  const top = [...new Set(paths)].slice(0, 3).join(', ');
  return [{
    key: 'server_errors',
    severity: 'critical',
    businessId: null,
    title: `Cloud: ${n} server errors in ${WATCHDOG.ERROR_WINDOW_MIN} min`,
    detail: top ? `Most recent: ${top}. Check the Render logs.` : 'Check the Render logs.',
  }];
}

export interface OpenDayRow { id: string; business_id: string; branch_id: string; terminal_code?: string | null; business_date: string; status: string; ends_at: string }

/** CRITICAL: a trading day still open 3 hours after its business day ended (ends_at = the next day at the cut-off). */
export function daysNotClosed(days: OpenDayRow[], now: Date, names: Record<string, string> = {}): Alert[] {
  const out: Alert[] = [];
  for (const d of days) {
    if (d.status !== 'open') continue;
    const over = ago(now, d.ends_at);
    if (!(over >= WATCHDOG.DAY_GRACE_MIN)) continue;
    out.push({
      key: `day_not_closed:${d.id}`,
      severity: 'critical',
      businessId: d.business_id,
      title: `${names[d.business_id] ?? 'A client'}: day ${d.business_date} not closed${d.terminal_code ? ` on ${d.terminal_code}` : ''}`,
      detail: `The business day ended ${durationLabel(over)} ago. A manager needs to count the cash and close it.`,
    });
  }
  return out;
}

/** WARNING: tills behind the client's approved version (or this cloud's release) or below the schema the cloud needs. */
export function oldTills(devices: DeviceRow[], latest: Record<string, string | null | undefined>, requiredSchema: number,
  names: Record<string, string> = {}): Alert[] {
  const per = new Map<string, string[]>();
  for (const d of devices) {
    if (!live(d) || !d.app_version) continue;
    const want = latest[d.business_id];
    const behind = (want && compareVersions(d.app_version, want) < 0)
      || (typeof d.schema_version === 'number' && d.schema_version < requiredSchema);
    if (behind) per.set(d.business_id, [...(per.get(d.business_id) ?? []), `${tillName(d)} v${d.app_version}`]);
  }
  return [...per].map(([biz, list]) => ({
    key: `old_tills:${biz}`,
    severity: 'warning' as Severity,
    businessId: biz,
    title: `${names[biz] ?? 'A client'}: ${list.length} till${list.length === 1 ? '' : 's'} need${list.length === 1 ? 's' : ''} updating`,
    detail: list.join(', '),
  }));
}

export interface EtimsRow { business_id: string; status: string }

/** WARNING: eTIMS invoices that failed to reach KRA. */
export function etimsFailures(rows: EtimsRow[], names: Record<string, string> = {}): Alert[] {
  const per = new Map<string, number>();
  for (const r of rows) if (r.status === 'failed') per.set(r.business_id, (per.get(r.business_id) ?? 0) + 1);
  return [...per].map(([biz, n]) => ({
    key: `etims_failed:${biz}`,
    severity: 'warning' as Severity,
    businessId: biz,
    title: `${names[biz] ?? 'A client'}: ${n} eTIMS invoice${n === 1 ? '' : 's'} failed`,
    detail: 'They are retried every 15 minutes; check the eTIMS settings if this stays.',
  }));
}

export interface SignInFailureRow { at: number; account: string; ip: string; where: 'admin' | 'dashboard' | 'web_pos' | 'till' }

const WHERE_LABEL: Record<SignInFailureRow['where'], string> = {
  admin: 'the admin portal', dashboard: 'the dashboard', web_pos: 'the web POS', till: 'a till',
};

/** CRITICAL (A392): someone keeps failing to sign in — one account, or many accounts from one address. */
export function repeatedSignInFailures(rows: SignInFailureRow[], now: Date): Alert[] {
  const since = now.getTime() - WATCHDOG.SIGNIN_WINDOW_MIN * MIN;
  const recent = rows.filter((r) => r.at >= since && r.at <= now.getTime());
  const out: Alert[] = [];
  const byAccount = new Map<string, SignInFailureRow[]>();
  for (const r of recent) {
    if (!r.account) continue;
    const k = `${r.where === 'admin' ? 'admin' : 'app'}:${r.account}`;   // an admin account has its own, lower bar
    byAccount.set(k, [...(byAccount.get(k) ?? []), r]);
  }
  for (const [key, list] of byAccount) {
    const admin = key.startsWith('admin:');
    if (list.length < (admin ? WATCHDOG.SIGNIN_ADMIN_ACCOUNT : WATCHDOG.SIGNIN_ACCOUNT)) continue;
    const ips = [...new Set(list.map((r) => r.ip).filter(Boolean))];
    out.push({
      key: `signin_failures:${key}`,
      severity: 'critical',
      businessId: null,
      title: `${list.length} failed sign-ins for ${list[0].account} on ${WHERE_LABEL[list[list.length - 1].where]}`,
      detail: `In the last ${WATCHDOG.SIGNIN_WINDOW_MIN} min, from ${ips.length ? ips.slice(0, 3).join(', ') + (ips.length > 3 ? ' …' : '') : 'an unknown address'}. `
        + (admin ? 'Someone may be guessing an admin password — check the Team page.' : 'A forgotten password, or someone guessing it.'),
    });
  }
  const byIp = new Map<string, SignInFailureRow[]>();
  for (const r of recent) if (r.ip) byIp.set(r.ip, [...(byIp.get(r.ip) ?? []), r]);
  for (const [ip, list] of byIp) {
    if (list.length < WATCHDOG.SIGNIN_IP) continue;
    const accounts = new Set(list.map((r) => r.account).filter(Boolean)).size;
    out.push({
      key: `signin_failures_ip:${ip}`,
      severity: 'critical',
      businessId: null,
      title: `${list.length} failed sign-ins from ${ip}`,
      detail: `In the last ${WATCHDOG.SIGNIN_WINDOW_MIN} min, on ${accounts} account${accounts === 1 ? '' : 's'}. Possibly someone trying passwords.`,
    });
  }
  return out;
}

export interface SyncAttemptRow { at: number; deviceId: string; businessId: string | null; ok: boolean; status: number;
  code?: string | null; error?: string | null; rejected?: number }

/** What a refusal means, in words an admin can act on. */
export function syncRefusalHint(status: number, code?: string | null): string {
  const c = String(code ?? '');
  if (status === 426 || c === 'desktop_upgrade_required') return 'The till runs a build this cloud no longer accepts — install the current ZapTill.';
  if (/LICEN[CS]E/i.test(c)) return 'The branch has no desktop licence — activate it on the client page.';
  if (/REVOKED|RETIRED|DEVICE/i.test(c)) return 'The till was revoked or retired — re-enrol it with a new code.';
  if (status === 401) return 'The till\'s sign-in is no longer accepted — sign in on the till again.';
  if (status === 403) return 'The cloud refuses this till — check its branch, licence and the client\'s status.';
  if (status === 409) return 'Its records clash with the cloud\'s (another till or business) — check the till\'s set-up.';
  if (status >= 500) return 'The cloud fails on this till\'s data — check the Render logs.';
  return 'Check the till\'s set-up.';
}

/**
 * CRITICAL (A392): a till the cloud keeps refusing — its sales are not arriving and retrying will not fix it.
 *   • 3+ pushes refused in the last 30 min, none taken, and the newest refused;
 *   • or rows refused on their merits (a 200 with `rejected`) in the last hour — the till will not send them again.
 */
export function tillSyncRefused(attempts: SyncAttemptRow[][], now: Date, names: Record<string, string> = {},
  tills: Record<string, string> = {}): Alert[] {
  const out: Alert[] = [];
  const t = now.getTime();
  for (const list of attempts) {
    if (!list.length) continue;
    const dev = list[list.length - 1].deviceId;
    const biz = [...list].reverse().find((a) => a.businessId)?.businessId ?? null;
    const who = `${biz ? names[biz] ?? 'A client' : 'A till'}: ${tills[dev] ?? `till ${dev.slice(0, 8)}`}`;
    const recent = list.filter((a) => a.at >= t - WATCHDOG.SYNC_WINDOW_MIN * MIN && a.at <= t);
    const fails = recent.filter((a) => !a.ok);
    const last = recent[recent.length - 1];
    if (last && !last.ok && fails.length >= WATCHDOG.SYNC_FAILS && !recent.some((a) => a.ok)) {
      out.push({
        key: `sync_refused:${dev}`,
        severity: 'critical',
        businessId: biz,
        title: `${who} — the cloud refuses its sync`,
        detail: `${fails.length} pushes refused in ${WATCHDOG.SYNC_WINDOW_MIN} min (HTTP ${last.status}${last.code ? ` ${last.code}` : ''}`
          + `${last.error ? `: ${last.error}` : ''}). ${syncRefusalHint(last.status, last.code)}`,
      });
      continue;
    }
    const rows = list.filter((a) => a.at >= t - WATCHDOG.SYNC_ROWS_WINDOW_MIN * MIN && a.at <= t && (a.rejected ?? 0) > 0);
    if (rows.length) {
      const n = rows.reduce((sum, a) => sum + (a.rejected ?? 0), 0);
      const r = rows[rows.length - 1];
      out.push({
        key: `sync_rows_refused:${dev}`,
        severity: 'critical',
        businessId: biz,
        title: `${who} — ${n} record${n === 1 ? '' : 's'} refused by the cloud`,
        detail: `${r.code ? `${r.code}: ` : ''}${r.error ?? 'refused'}. The till will not send ${n === 1 ? 'it' : 'them'} again — they need a person.`,
      });
    }
  }
  return out;
}

export interface OpenAlertRow { id: string; alert_key: string; severity: Severity; title: string; detail?: string | null;
  first_seen_at: string; last_notified_at?: string | null; notify_count?: number | null; acknowledged_at?: string | null }

export interface RunPlan {
  /** New problems: store them; the critical ones are sent now. */
  opened: Alert[];
  /** Problems already open: still there (last_seen_at moves). */
  stillOpen: { row: OpenAlertRow; alert: Alert }[];
  /** Of stillOpen, the critical ones due a reminder. */
  remind: { row: OpenAlertRow; alert: Alert }[];
  /** Open problems no longer found: mark resolved; the critical ones get a "resolved" message. */
  resolved: OpenAlertRow[];
}

/**
 * One run: what is new, what is still there (and due a reminder), what has cleared. A warning is never sent from here —
 * the morning digest lists them. A warning that turns critical (M-Pesa: one → two) is sent as new.
 */
export function planRun(current: Alert[], open: OpenAlertRow[], now: Date): RunPlan {
  const byKey = new Map(open.map((r) => [r.alert_key, r]));
  const seen = new Set<string>();
  const plan: RunPlan = { opened: [], stillOpen: [], remind: [], resolved: [] };
  for (const a of current) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    const row = byKey.get(a.key);
    if (!row) { plan.opened.push(a); continue; }
    plan.stillOpen.push({ row, alert: a });
    if (a.severity !== 'critical') continue;
    if (row.acknowledged_at && row.severity === 'critical') continue;   // A392: an admin muted it in the portal
    const last = row.severity === 'critical' ? row.last_notified_at : null;   // warning → critical: tell now
    if (!last || ago(now, last) >= WATCHDOG.REMIND_MIN) plan.remind.push({ row, alert: a });
  }
  for (const r of open) if (!seen.has(r.alert_key)) plan.resolved.push(r);
  return plan;
}

/** The text of one message (Telegram and email alike; plain text, one problem). */
export function alertText(kind: 'new' | 'reminder' | 'resolved', a: { title: string; detail?: string | null }, since?: string | null, now?: Date): string {
  if (kind === 'resolved') {
    const dur = since && now ? ` (lasted ${durationLabel(ago(now, since))})` : '';
    return `✅ RESOLVED — ${a.title}${dur}`;
  }
  const head = kind === 'new' ? '🔴 ZapTill ALERT' : '🔴 STILL HAPPENING';
  const dur = kind === 'reminder' && since && now ? ` — for ${durationLabel(ago(now, since))}` : '';
  return `${head}${dur}\n${a.title}\n${a.detail ?? ''}`.trim();
}

export interface DigestCounters { writeGuard: number; failedSignIns: number; serverErrors: number; since: string }

/** The morning digest: every open problem (critical first), then the counters since the last digest. */
export function digestText(open: { severity: Severity; title: string; detail?: string | null; first_seen_at?: string }[],
  counters: DigestCounters, now: Date): string {
  const lines: string[] = [`☀️ ZapTill daily check — ${now.toISOString().slice(0, 10)}`];
  const crit = open.filter((a) => a.severity === 'critical');
  const warn = open.filter((a) => a.severity === 'warning');
  if (!crit.length && !warn.length) lines.push('', 'All clients look healthy.');
  if (crit.length) lines.push('', `🔴 Still open (${crit.length}):`, ...crit.map((a) => `• ${a.title}`));
  if (warn.length) lines.push('', `🟡 To look at (${warn.length}):`, ...warn.map((a) => `• ${a.title}${a.detail ? ` — ${a.detail}` : ''}`));
  lines.push('', `Since ${counters.since.slice(0, 16).replace('T', ' ')} UTC:`,
    `• Server errors: ${counters.serverErrors}`,
    `• Failed sign-ins: ${counters.failedSignIns}`,
    `• Till writes the cloud would block (A159): ${counters.writeGuard}`);
  return lines.join('\n');
}
