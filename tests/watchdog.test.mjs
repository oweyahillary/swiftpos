/**
 * watchdog.test.mjs — A383: the cloud tells the admin first (Telegram + email), before the client calls.
 *
 * Owner, 2026-10-03: "getting this errors critical one first hand before the client calls like an email notification or
 * something proactive not reactive" — "telegram and email combo is fine". The rules (lib/watchdogRules.ts, pure) run for
 * real; the counters run for real; source pins on the job, the notifier, the wiring and the admin portal.
 *
 * MUTATIONS TO CONFIRM BITE: tillsNotSyncing without the "seen recently" test → "a till that is off is not a sync
 * alert" fails; planRun reminding every run → "a reminder only every 3 hours" fails; planRun sending warnings →
 * "warnings wait for the digest" fails; daysNotClosed without the grace → "3 hours of grace" fails; dropping the
 * mpesa critical count → "one unanswered request is a warning" fails.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const R = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/watchdogRules.ts')).href);
const K = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/watchdogCounters.ts')).href);

const NOW = new Date('2026-10-03T12:00:00Z');
const minAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const names = { b1: 'African Fries' };

await ok('a till that is ON but has not synced for 2 hours is critical', () => {
  const a = R.tillsNotSyncing([{ id: 'd1', business_id: 'b1', terminal_code: 'T1', status: 'approved', last_seen_at: minAgo(5), last_sync_at: minAgo(150) }], NOW, names);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'critical');
  assert.strictEqual(a[0].key, 'till_not_syncing:d1');
  assert.match(a[0].title, /African Fries: T1 is on but not syncing/);
  assert.match(a[0].detail, /2 h 30 min/);
});
await ok('a till that is off (not seen) is not a sync alert; nor one that synced lately; nor a retired one', () => {
  assert.deepStrictEqual(R.tillsNotSyncing([{ id: 'd', business_id: 'b1', last_seen_at: minAgo(200), last_sync_at: minAgo(300) }], NOW), []);
  assert.deepStrictEqual(R.tillsNotSyncing([{ id: 'd', business_id: 'b1', last_seen_at: minAgo(1), last_sync_at: minAgo(30) }], NOW), []);
  assert.deepStrictEqual(R.tillsNotSyncing([{ id: 'd', business_id: 'b1', retired_at: minAgo(9), last_seen_at: minAgo(1), last_sync_at: minAgo(300) }], NOW), []);
  assert.deepStrictEqual(R.tillsNotSyncing([{ id: 'd', business_id: 'b1', status: 'pending', last_seen_at: minAgo(1) }], NOW), []);
});
await ok('one unanswered M-Pesa request is a warning; two is critical; a fresh one (< 10 min) is not counted', () => {
  const row = (m) => ({ id: String(m), business_id: 'b1', status: 'pending', mpesa_requested_at: minAgo(m) });
  assert.deepStrictEqual(R.mpesaUnanswered([row(3)], NOW), []);
  assert.strictEqual(R.mpesaUnanswered([row(15)], NOW)[0].severity, 'warning');
  const two = R.mpesaUnanswered([row(15), row(40), row(3)], NOW, names);
  assert.strictEqual(two[0].severity, 'critical');
  assert.match(two[0].title, /2 M-Pesa payments with no answer/);
  assert.deepStrictEqual(R.mpesaUnanswered([{ ...row(15), status: 'completed' }], NOW), []);
});
await ok('an unresolved payment exception is critical, one alert per client', () => {
  const a = R.paymentExceptions([
    { id: '1', business_id: 'b1', reason: 'Paid 900, asked 1000', created_at: minAgo(5) },
    { id: '2', business_id: 'b1', reason: 'Paid 50', created_at: minAgo(9) },
    { id: '3', business_id: 'b2', reason: 'x', created_at: minAgo(9), resolved_at: minAgo(1) },
  ], names);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'critical');
  assert.match(a[0].detail, /Paid 900/);
});
await ok('10 server errors in 5 minutes is a burst; 9 is not; old ones do not count', () => {
  const at = (m) => NOW.getTime() - m * 60_000;
  assert.strictEqual(R.errorBurst(Array.from({ length: 10 }, () => at(1)), NOW, ['/api/sync/push']).length, 1);
  assert.strictEqual(R.errorBurst(Array.from({ length: 9 }, () => at(1)), NOW).length, 0);
  assert.strictEqual(R.errorBurst(Array.from({ length: 20 }, () => at(30)), NOW).length, 0);
});
await ok('a day still open 3 hours after its business day ended is critical; 3 hours of grace', () => {
  const day = (endedMin) => ({ id: 'x', business_id: 'b1', branch_id: 'r', terminal_code: 'T1', business_date: '2026-10-02', status: 'open', ends_at: minAgo(endedMin) });
  assert.strictEqual(R.daysNotClosed([day(170)], NOW).length, 0);
  const a = R.daysNotClosed([day(200)], NOW, names);
  assert.strictEqual(a.length, 1);
  assert.match(a[0].title, /day 2026-10-02 not closed on T1/);
  assert.strictEqual(R.daysNotClosed([{ ...day(500), status: 'closed' }], NOW).length, 0);
});
await ok('tills behind the approved version or the schema are a warning; no approved version = only the schema', () => {
  const d = (v, s) => ({ id: v + s, business_id: 'b1', terminal_code: 'T' + v, app_version: v, schema_version: s });
  const a = R.oldTills([d('0.6.30', 64), d('0.6.34', 64)], { b1: '0.6.34' }, 64, names);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'warning');
  assert.match(a[0].detail, /T0\.6\.30 v0\.6\.30/);
  assert.strictEqual(R.oldTills([d('0.6.30', 64)], { b1: null }, 64).length, 0);
  assert.strictEqual(R.oldTills([d('0.6.30', 60)], { b1: null }, 64).length, 1);
});
await ok('eTIMS failures are a warning per client', () => {
  const a = R.etimsFailures([{ business_id: 'b1', status: 'failed' }, { business_id: 'b1', status: 'failed' }, { business_id: 'b1', status: 'signed' }], names);
  assert.strictEqual(a.length, 1);
  assert.match(a[0].title, /2 eTIMS invoices failed/);
});

const crit = { key: 'k1', severity: 'critical', businessId: 'b1', title: 'T', detail: 'D' };
const warnA = { key: 'w1', severity: 'warning', businessId: 'b1', title: 'W', detail: '' };
const openRow = (key, sev, notifiedMin) => ({ id: key + '-id', alert_key: key, severity: sev, title: key, first_seen_at: minAgo(600), last_notified_at: notifiedMin == null ? null : minAgo(notifiedMin) });

await ok('a new problem is opened; a warning is stored but not sent (the digest lists it)', () => {
  const p = R.planRun([crit, warnA], [], NOW);
  assert.deepStrictEqual(p.opened.map((a) => a.key), ['k1', 'w1']);
  assert.strictEqual(p.remind.length, 0);
  const p2 = R.planRun([warnA], [openRow('w1', 'warning', null)], NOW);
  assert.strictEqual(p2.remind.length, 0);
  assert.strictEqual(p2.stillOpen.length, 1);
});
await ok('a reminder only every 3 hours while it lasts', () => {
  assert.strictEqual(R.planRun([crit], [openRow('k1', 'critical', 20)], NOW).remind.length, 0);
  assert.strictEqual(R.planRun([crit], [openRow('k1', 'critical', 181)], NOW).remind.length, 1);
});
await ok('a warning that turns critical is told at once', () => {
  assert.strictEqual(R.planRun([crit], [openRow('k1', 'warning', null)], NOW).remind.length, 1);
});
await ok('a problem no longer found is resolved', () => {
  const p = R.planRun([], [openRow('k1', 'critical', 20)], NOW);
  assert.deepStrictEqual(p.resolved.map((r) => r.alert_key), ['k1']);
});
await ok('the messages: new, reminder with how long, resolved; the digest lists critical then warnings and the counters', () => {
  assert.match(R.alertText('new', crit), /^🔴 SwiftPOS ALERT\nT\nD$/);
  assert.match(R.alertText('reminder', crit, minAgo(200), NOW), /STILL HAPPENING — for 3 h 20 min/);
  assert.match(R.alertText('resolved', crit, minAgo(45), NOW), /RESOLVED — T \(lasted 45 min\)/);
  const d = R.digestText([{ severity: 'warning', title: 'W1', detail: 'x' }, { severity: 'critical', title: 'C1' }],
    { writeGuard: 3, failedSignIns: 7, serverErrors: 2, since: '2026-10-02T04:45:00Z' }, NOW);
  assert.ok(d.indexOf('C1') < d.indexOf('W1'));
  assert.match(d, /Failed sign-ins: 7/);
  assert.match(d, /\(A159\): 3/);
  assert.match(R.digestText([], { writeGuard: 0, failedSignIns: 0, serverErrors: 0, since: NOW.toISOString() }, NOW), /All clients look healthy/);
});
await ok('the counters: 5xx kept for the burst rule, sign-in failures recognised, the digest resets them', () => {
  K.recordServerError('/api/x?y=1');
  K.recordFailedSignIn();
  K.recordWriteGuard();
  assert.ok(K.recentErrors().times.length >= 1);
  assert.strictEqual(K.recentErrors().paths[0], '/api/x');
  const c = K.digestCounters(true);
  assert.deepStrictEqual([c.serverErrors, c.failedSignIns, c.writeGuard], [1, 1, 1]);
  assert.deepStrictEqual(Object.values(K.digestCounters()).slice(0, 3), [0, 0, 0]);
  assert.ok(K.isSignInFailure('POST', '/api/auth/pos-login', 401));
  assert.ok(K.isSignInFailure('POST', '/api/admin/auth/login', 401));
  assert.ok(K.isSignInFailure('POST', '/api/staff/clock', 401));
  assert.ok(!K.isSignInFailure('POST', '/api/auth/refresh', 401));
  assert.ok(!K.isSignInFailure('POST', '/api/auth/login', 200));
});

await ok('wiring: the job starts with the server; 5xx and sign-in failures are counted; the write guard counts', () => {
  const idx = read('apps/server/src/index.ts');
  assert.match(idx, /startWatchdogJob\(\);/);
  assert.match(idx, /res\.statusCode >= 500\) recordServerError/);
  assert.match(idx, /isSignInFailure\(req\.method, path, res\.statusCode\)\) recordFailedSignIn/);
  const auth = read('apps/server/src/middleware/auth.ts');
  assert.match(auth, /terminalWriteDenied\(req\.surface[^\n]*return false;\n\s*recordWriteGuard\(\);/);
});
await ok('the job: every 10 min, digest 07:45 Nairobi, stores what it said, never overlaps, can be turned off', () => {
  const j = read('apps/server/src/jobs/watchdog.ts');
  assert.match(j, /WATCHDOG_CRON \?\? '\*\/10 \* \* \* \*'/);
  assert.match(j, /WATCHDOG_DIGEST_CRON \?\? '45 7 \* \* \*'/);
  assert.match(j, /timezone: 'Africa\/Nairobi'/);
  assert.match(j, /from\('watchdog_alerts'\)\.insert/);
  assert.match(j, /if \(running\) return;/);
  assert.match(j, /WATCHDOG_ENABLED/);
  assert.match(j, /getDayCutoff\(d\.business_id, d\.branch_id\)/);    // the owner's cut-off (0.6.34) decides when a day ended
});
await ok('the notifier: Telegram and email together, plain text, never throws', () => {
  const n = read('apps/server/src/lib/alertNotify.ts');
  assert.match(n, /api\.telegram\.org/);
  assert.match(n, /TELEGRAM_BOT_TOKEN/);
  assert.match(n, /TELEGRAM_CHAT_ID/);
  assert.match(n, /ADMIN_ALERT_EMAIL/);
  assert.match(n, /sendEmailChecked/);
  assert.doesNotMatch(n, /parse_mode\s*:/);
  assert.match(read('render.yaml'), /key: TELEGRAM_BOT_TOKEN[\s\S]*key: TELEGRAM_CHAT_ID[\s\S]*key: ADMIN_ALERT_EMAIL/);
});
await ok('the admin portal: the watchdog card and a test alert (super admin only)', () => {
  const a = read('apps/server/src/routes/admin.ts');
  assert.match(a, /router\.get\('\/watchdog', requireAdmin/);
  assert.match(a, /router\.post\('\/watchdog\/test', requireSuperAdmin/);
  const p = read('apps/admin/src/AdminPortal.tsx');
  assert.match(p, /<WatchdogCard req=\{req\} \/>/);
  assert.match(p, /req\("POST", "\/watchdog\/test"\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
