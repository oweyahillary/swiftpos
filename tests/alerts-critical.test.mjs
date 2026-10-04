/**
 * alerts-critical.test.mjs — A392: only critical failures are emailed; everything is on the admin portal's Alerts page.
 *
 * Owner, 2026-10-04: "include alerts in the admin portal — all alerts emails should only get critical failures like
 * continuous failed login attempts, failed sync due to misconfigs, critical alerts only; others put in the admin".
 * The rules (lib/watchdogRules.ts, pure) and the counters run for real; source pins on the job, the notifier, the
 * request hook and the portal.
 *
 * MUTATIONS TO CONFIRM BITE: repeatedSignInFailures with one bar for every account → "an admin account at 5" fails;
 * tillSyncRefused alerting while a push still succeeds → "a refusal then a success is not an alert" fails; planRun
 * ignoring acknowledged_at → "a muted alert is not reminded" fails; the digest or "resolved" emailed → their pins fail;
 * notifyAdmin ignoring email:false → "Telegram only" fails.
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

const NOW = new Date('2026-10-04T12:00:00Z');
const at = (m) => NOW.getTime() - m * 60_000;
const fails = (n, account, where = 'dashboard', ip = '41.90.12.7', spread = 1) =>
  Array.from({ length: n }, (_, i) => ({ at: at(i * spread), account, ip, where }));

console.log('\nRepeated failed sign-ins (critical, emailed)\n');
await ok('8 failed sign-ins on one account in 15 min is critical; 7 is not', () => {
  assert.deepEqual(R.repeatedSignInFailures(fails(7, 'owner@x.co.ke'), NOW), []);
  const a = R.repeatedSignInFailures(fails(8, 'owner@x.co.ke'), NOW);
  assert.equal(a.length, 1); assert.equal(a[0].severity, 'critical'); assert.equal(a[0].key, 'signin_failures:app:owner@x.co.ke');
  assert.match(a[0].title, /8 failed sign-ins for owner@x\.co\.ke on the dashboard/);
  assert.match(a[0].detail, /41\.90\.12\.7/);
});
await ok('an admin account alerts at 5', () => {
  const a = R.repeatedSignInFailures(fails(5, 'hillary@zaptill.co.ke', 'admin'), NOW);
  assert.equal(a.length, 1); assert.match(a[0].title, /on the admin portal/); assert.match(a[0].detail, /admin password/);
});
await ok('spread over more than 15 min is not "continuous"', () => {
  assert.deepEqual(R.repeatedSignInFailures(fails(10, 'owner@x.co.ke', 'dashboard', '1.1.1.1', 3), NOW), []);
});
await ok('20 from one address across many accounts is critical (someone trying passwords)', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ at: at(0), account: `u${i}@x.co.ke`, ip: '9.9.9.9', where: 'web_pos' }));
  const a = R.repeatedSignInFailures(rows, NOW);
  assert.equal(a.length, 1); assert.equal(a[0].key, 'signin_failures_ip:9.9.9.9'); assert.match(a[0].detail, /20 accounts/);
});
await ok('the request hook records who failed and where (account lower-cased)', () => {
  K.resetCounters();
  K.recordFailedSignIn({ path: '/api/admin/auth/login', account: 'Hillary@ZapTill.co.ke', ip: '1.2.3.4' }, at(1));
  K.recordFailedSignIn({ path: '/api/auth/pos-login', account: 'mary@x.co.ke', ip: '1.2.3.4' }, at(1));
  K.recordFailedSignIn({ path: '/api/auth/login', account: 'o@x.co.ke', ip: '1.2.3.4' }, at(1));
  const r = K.recentSignInFailures();
  assert.deepEqual(r.map((f) => f.where), ['admin', 'web_pos', 'dashboard']);
  assert.equal(r[0].account, 'hillary@zaptill.co.ke');
  assert.equal(K.digestCounters().failedSignIns, 3);
});

console.log('\nA till the cloud keeps refusing (critical, emailed)\n');
const att = (m, ok, status = 403, code = 'BRANCH_NOT_LICENSED', extra = {}) =>
  ({ at: at(m), deviceId: 'dev-1', businessId: 'b1', ok, status, code, error: ok ? null : 'Westlands does not have a desktop licence.', ...extra });
await ok('3 refusals in 30 min, nothing taken → critical, with what to do', () => {
  const a = R.tillSyncRefused([[att(20, false), att(10, false), att(1, false)]], NOW, { b1: 'African Fries' }, { 'dev-1': 'T2' });
  assert.equal(a.length, 1); assert.equal(a[0].key, 'sync_refused:dev-1'); assert.equal(a[0].severity, 'critical');
  assert.match(a[0].title, /African Fries: T2 — the cloud refuses its sync/);
  assert.match(a[0].detail, /HTTP 403 BRANCH_NOT_LICENSED/); assert.match(a[0].detail, /activate it on the client page/);
});
await ok('a refusal then a success (a token refreshed) is not an alert; two refusals are not', () => {
  assert.deepEqual(R.tillSyncRefused([[att(20, false, 401, null), att(19, true, 200, null), att(10, false), att(1, false)]], NOW), []);
  assert.deepEqual(R.tillSyncRefused([[att(10, false), att(1, false)]], NOW), []);
});
await ok('records refused on their merits (a 200 with rejected rows) are critical — the till will not resend them', () => {
  const a = R.tillSyncRefused([[att(5, true, 200, 'duplicate_open_day', { rejected: 2, error: 'one open day per till' })]], NOW, { b1: 'African Fries' });
  assert.equal(a.length, 1); assert.equal(a[0].key, 'sync_rows_refused:dev-1'); assert.match(a[0].title, /2 records refused/);
});
await ok('the hint names the fix: an old build, a revoked till, a missing licence', () => {
  assert.match(R.syncRefusalHint(426, 'desktop_upgrade_required'), /install the current ZapTill/);
  assert.match(R.syncRefusalHint(403, 'DEVICE_REVOKED'), /re-enrol/);
  assert.match(R.syncRefusalHint(403, 'BRANCH_NOT_LICENSED'), /licence/);
});
await ok('the hook records a till\'s pushes only (sync and orders, POST)', () => {
  assert.ok(K.isTillSync('POST', '/api/sync/push')); assert.ok(K.isTillSync('POST', '/api/orders'));
  assert.ok(!K.isTillSync('GET', '/api/orders')); assert.ok(!K.isTillSync('POST', '/api/orders/x/void'));
  K.resetCounters();
  K.recordSyncAttempt({ deviceId: 'dev-1, dev-1', businessId: 'b1', ok: false, status: 403, code: 'X' });
  assert.equal(K.recentSyncAttempts()[0][0].deviceId, 'dev-1', 'a header sent twice is read once');
  const ix = read('apps/server/src/index.ts');
  assert.match(ix, /const tillSync = isTillSync\(req\.method, path0\) && !!req\.header\('X-Device-Id'\);/);
  assert.match(ix, /recordFailedSignIn\(\{ path, account: typeof req\.body\?\.email === 'string' \? req\.body\.email : '', ip: req\.ip \?\? '' \}\);/);
});

console.log('\nOnly critical problems are emailed; mute; the portal\n');
await ok('a muted (acknowledged) critical alert is not reminded; it stays open', () => {
  const alert = { key: 'k', severity: 'critical', businessId: null, title: 't', detail: 'd' };
  const row = { id: '1', alert_key: 'k', severity: 'critical', title: 't', first_seen_at: new Date(at(600)).toISOString(), last_notified_at: new Date(at(400)).toISOString() };
  assert.equal(R.planRun([alert], [row], NOW).remind.length, 1);
  const muted = R.planRun([alert], [{ ...row, acknowledged_at: new Date(at(300)).toISOString() }], NOW);
  assert.equal(muted.remind.length, 0); assert.equal(muted.stillOpen.length, 1);
});
await ok('the digest and "resolved" go to Telegram only; new and still-happening critical ones are emailed', () => {
  const w = read('apps/server/src/jobs/watchdog.ts');
  assert.match(w, /await notifyAdmin\(`ZapTill resolved: \$\{row\.title\}`, alertText\('resolved', row, row\.first_seen_at, now\), \{ email: false \}\);/);
  assert.match(w, /await notifyAdmin\(`ZapTill daily check — \$\{now\.toISOString\(\)\.slice\(0, 10\)\}`, text, \{ email: false \}\);/);
  assert.match(w, /if \(critical\) await notifyAdmin\(`ZapTill alert: \$\{a\.title\}`, alertText\('new', a\)\);/);
  assert.match(w, /repeatedSignInFailures\(recentSignInFailures\(\), now\)/);
  assert.match(w, /return tillSyncRefused\(attempts, now, nm, tills\);/);
});
await ok('notifyAdmin({ email: false }) never emails, whatever is set', async () => {
  process.env.ADMIN_ALERT_EMAIL = 'me@x.co.ke'; delete process.env.TELEGRAM_BOT_TOKEN;
  const N = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/alertNotify.ts')).href).catch(() => null);
  const src = read('apps/server/src/lib/alertNotify.ts');
  assert.match(src, /const ch = \{ telegram: all\.telegram, email: all\.email && opts\.email !== false \};/);
  if (N) {
    const r = await N.notifyAdmin('s', 't', { email: false });
    assert.deepEqual(r, { telegram: false, email: false });
  }
  delete process.env.ADMIN_ALERT_EMAIL;
});
await ok('the portal: an Alerts page (open / resolved, mute), a count on the menu, a summary on the dashboard', () => {
  const p = read('apps/admin/src/AlertsPage.tsx');
  assert.match(p, /req\("POST", `\/watchdog\/\$\{a\.id\}\/ack`, \{ mute: on \}\)/);
  assert.match(p, /\/watchdog\$\{view === "resolved" \? "\?status=resolved" : ""\}/);
  const ap = read('apps/admin/src/AdminPortal.tsx');
  assert.match(ap, /\{ id: "alerts",\s+icon: "⚠", label: "Alerts" \}/);
  assert.match(ap, /const critical = useCriticalCount\(req, Boolean\(token && admin\)\);/);
  assert.match(ap, /<AlertsSummary req=\{req\} onOpen=\{onOpenAlerts\} \/>/);
  const a = read('apps/server/src/routes/admin.ts');
  assert.match(a, /router\.post\('\/watchdog\/:id\/ack', requireAdmin,/);
  assert.match(a, /res\.json\(\{ channels: alertChannels\(\), alerts: data \?\? \[\], counters: digestCounters\(false\), recent: \{ signins, sync \} \}\);/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
