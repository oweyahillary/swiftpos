/**
 * till-heartbeat-a579.test.mjs — A579: "on but not syncing" only when it means something.
 *
 * Owner, 2026-10-23, on two critical emails about TJS PIZZA's T1 ("Last sync 7 h 31 min ago", then "9 h 1 min"): "This
 * emails of not syncing maybe its just that no trade is taking place". The rules (lib/watchdogRules.ts, pure) and the
 * queue counters (lib/watchdogCounters.ts) run for real; source pins on the job, the wiring and the owner alerts.
 *
 * MUTATIONS TO CONFIRM BITE (each made in src, seen to fail, reverted):
 *   sendsHeartbeat always true (the old rule)                  → "an old idle till is a WARNING, never emailed" fails
 *   the trade-evidence branch removed (always warning)         → "an old till with trade evidence is CRITICAL" fails
 *   the ownSales check removed                                 → "its own sales arriving: nothing to say" fails
 *   recordSyncQueue keeping pendingSince on every report       → "pendingSince is the start of the streak" fails
 *   planRun reminding warnings                                 → "a quiet till is never reminded" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${e.message}`); } };

const R = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/watchdogRules.ts')).href);
const K = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/lib/watchdogCounters.ts')).href);

const NOW = new Date('2026-10-23T19:00:00Z');
const minAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const names = { b1: 'TJS PIZZA CHIKEN AND FRIES' };
const till = (o = {}) => ({ id: 'row-t1', device_id: 'dev-t1', branch_id: 'br1', business_id: 'b1', terminal_code: 'T1', status: 'approved',
  last_seen_at: minAgo(7), last_sync_at: minAgo(451), ...o });

await ok('a 1.0.20 till that checks in while idle: no alert', () => {
  // the heartbeat moved last_sync_at 12 min ago — nothing sold all evening
  assert.deepStrictEqual(R.tillsNotSyncing([till({ app_version: '1.0.20', last_sync_at: minAgo(12) })], NOW, names), []);
  assert.deepStrictEqual(R.tillsNotSyncing([till({ app_version: '1.0.21', last_sync_at: minAgo(110) })], NOW, names), []);
});
await ok('a 1.0.20 till seen but whose heartbeat stopped: CRITICAL, as before', () => {
  const a = R.tillsNotSyncing([till({ app_version: '1.0.20' })], NOW, names);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'critical');
  assert.strictEqual(a[0].key, 'till_not_syncing:row-t1');
  assert.match(a[0].title, /TJS PIZZA CHIKEN AND FRIES: T1 is on but not syncing/);
  assert.match(a[0].detail, /7 h 31 min/);
  assert.match(a[0].detail, /every 15 min even when idle/);
});
await ok('a till whose push reported its queue counts as a heartbeat till whatever its version says', () => {
  const queues = { 'dev-t1': { pending: 0, failed: 0, at: NOW.getTime() - 451 * 60_000 } };
  const a = R.tillsNotSyncing([till({ app_version: null })], NOW, names, { queues });
  assert.strictEqual(a[0].severity, 'critical');
  assert.strictEqual(R.sendsHeartbeat({ app_version: '1.0.19' }), false);
  assert.strictEqual(R.sendsHeartbeat({ app_version: '1.0.20' }), true);
  assert.strictEqual(R.sendsHeartbeat({ app_version: '1.0.19' }, { pending: 3, failed: 0, at: 1 }), true);
});
await ok('pending > 0 at its last report: "N sales waiting"', () => {
  const queues = { 'dev-t1': { pending: 14, failed: 0, at: NOW.getTime() - 451 * 60_000 } };
  const a = R.tillsNotSyncing([till({ app_version: '1.0.20' })], NOW, names, { queues });
  assert.match(a[0].detail, /14 sales and records waiting/);
  const one = R.tillsNotSyncing([till({ app_version: '1.0.20' })], NOW, names, { queues: { 'dev-t1': { pending: 1, failed: 0, at: 1 } } });
  assert.match(one[0].detail, /1 sale and records waiting/);
  assert.doesNotMatch(R.tillsNotSyncing([till({ app_version: '1.0.20' })], NOW, names)[0].detail, /waiting/);
});
await ok('an old idle till (TJ\'s T1 on 1.0.5, no trade evidence) is a WARNING, never emailed', () => {
  const a = R.tillsNotSyncing([till({ app_version: '1.0.5' })], NOW, names, { evidence: { 'row-t1': { openShift: false, otherSales: 0, ownSales: 0 } } });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'warning');
  assert.strictEqual(a[0].key, 'till_not_syncing:row-t1', 'same key: an open critical settles to a warning, no "resolved"');
  assert.match(a[0].title, /T1 quiet for 7 h 31 min — no sales sent/);
  assert.match(a[0].detail, /If it was trading, check it/);
  assert.match(a[0].detail, /v1\.0\.5/);
  // a drawer open but the branch sold nothing else: still quiet; others sold but no drawer on it: still quiet
  assert.strictEqual(R.tillsNotSyncing([till({ app_version: '1.0.5' })], NOW, names, { evidence: { 'row-t1': { openShift: true, otherSales: 0 } } })[0].severity, 'warning');
  assert.strictEqual(R.tillsNotSyncing([till({ app_version: '1.0.5' })], NOW, names, { evidence: { 'row-t1': { openShift: false, otherSales: 9 } } })[0].severity, 'warning');
  // no evidence read at all (a failed read): a warning, never a false critical
  assert.strictEqual(R.tillsNotSyncing([till({ app_version: '1.0.5' })], NOW, names)[0].severity, 'warning');
});
await ok('an old till with trade evidence (a drawer open on it, the branch\'s other tills selling) is CRITICAL', () => {
  const a = R.tillsNotSyncing([till({ app_version: '1.0.19' })], NOW, names, { evidence: { 'row-t1': { openShift: true, otherSales: 23, ownSales: 0 } } });
  assert.strictEqual(a[0].severity, 'critical');
  assert.match(a[0].title, /T1 is on but not syncing/);
  assert.match(a[0].detail, /other points of sale sent 23 sales since, but none came from this POS/);
});
await ok('an old till whose own sales are arriving (through /api/orders): nothing to say', () => {
  assert.deepStrictEqual(R.tillsNotSyncing([till({ app_version: '1.0.19' })], NOW, names, { evidence: { 'row-t1': { openShift: true, otherSales: 23, ownSales: 4 } } }), []);
});
await ok('quietCandidates: on, stale, without the heartbeat — the only tills the job reads evidence for', () => {
  const list = [till({ id: 'a', app_version: '1.0.5' }), till({ id: 'b', app_version: '1.0.20' }), till({ id: 'c', app_version: '1.0.5', last_sync_at: minAgo(30) }),
    till({ id: 'd', app_version: '1.0.5', last_seen_at: minAgo(300) }), till({ id: 'e', app_version: '1.0.5', retired_at: minAgo(1) })];
  assert.deepStrictEqual(R.quietCandidates(list, NOW).map((d) => d.id), ['a']);
});
await ok('a quiet till is never reminded; one that turns critical is sent as new', () => {
  const quiet = R.tillsNotSyncing([till({ app_version: '1.0.5' })], NOW, names)[0];
  const row = { id: 'w1', alert_key: quiet.key, severity: 'warning', title: quiet.title, first_seen_at: minAgo(600), last_notified_at: null };
  const p = R.planRun([quiet], [row], NOW);
  assert.strictEqual(p.remind.length, 0);
  assert.strictEqual(p.opened.length, 0);
  // an open CRITICAL from the old rule (emailed 4 h ago) is not reminded once it is only a quiet till
  const was = { ...row, severity: 'critical', last_notified_at: minAgo(240) };
  const p2 = R.planRun([quiet], [was], NOW);
  assert.strictEqual(p2.remind.length, 0);
  assert.strictEqual(p2.resolved.length, 0, 'no "resolved" message either');
  const crit = R.tillsNotSyncing([till({ app_version: '1.0.5' })], NOW, names, { evidence: { 'row-t1': { openShift: true, otherSales: 2 } } })[0];
  assert.strictEqual(R.planRun([crit], [row], NOW).remind.length, 1);
});
await ok('a till reporting refused (parked) records: a WARNING for the digest, only from a fresh report', () => {
  const q = (failed, at) => ({ 'dev-t1': { pending: 0, failed, at } });
  const w = R.tillsWithParkedRecords([till()], NOW, names, q(2, NOW.getTime() - 5 * 60_000));
  assert.strictEqual(w.length, 1); assert.strictEqual(w[0].severity, 'warning'); assert.match(w[0].title, /2 records the cloud refused/);
  assert.deepStrictEqual(R.tillsWithParkedRecords([till()], NOW, names, q(0, NOW.getTime())), []);
  assert.deepStrictEqual(R.tillsWithParkedRecords([till()], NOW, names, q(2, NOW.getTime() - 120 * 60_000)), []);
});
await ok('queue counters: X-Sync-Pending / X-Sync-Failed parsed and kept per till; pendingSince is the start of the streak', () => {
  K.resetCounters();
  assert.strictEqual(K.parseQueueCount('12'), 12);
  assert.strictEqual(K.parseQueueCount('12, 12'), 12);
  assert.strictEqual(K.parseQueueCount(undefined), null);
  assert.strictEqual(K.parseQueueCount('-1'), null);
  assert.strictEqual(K.parseQueueCount('abc'), null);
  K.recordSyncQueue('dev-t1', null, 3, 1000);
  assert.deepStrictEqual(K.syncQueueReports(), {}, 'no pending count: nothing recorded');
  K.recordSyncQueue('dev-t1', 2, 0, 1000);
  K.recordSyncQueue('dev-t1, dev-t1', 5, 1, 2000);
  let r = K.syncQueueReports()['dev-t1'];
  assert.deepStrictEqual([r.pending, r.failed, r.at, r.pendingSince], [5, 1, 2000, 1000]);
  K.recordSyncQueue('dev-t1', 0, 0, 3000);
  r = K.syncQueueReports()['dev-t1'];
  assert.strictEqual(r.pendingSince, null);
  K.recordSyncQueue('dev-t1', 1, 0, 4000);
  assert.strictEqual(K.syncQueueReports()['dev-t1'].pendingSince, 4000);
  K.resetCounters();
});
await ok('wiring: the job reads evidence and queues; the cloud records the headers on a taken /sync/push; owner alerts', () => {
  const job = read('apps/server/src/jobs/watchdog.ts');
  assert.match(job, /quietCandidates\(devices, now, queues\)/);
  assert.match(job, /tillsNotSyncing\(devices, now, nm, \{ queues, evidence \}\)/);
  assert.match(job, /\.from\('orders'\)\.select\('device_id'\)/);
  assert.match(job, /device_id, device_label/);
  const idx = read('apps/server/src/index.ts');
  assert.match(idx, /recordSyncQueue\(String\(req\.header\('X-Device-Id'\)\), parseQueueCount\(req\.header\('X-Sync-Pending'\)\)/);
  assert.match(idx, /res\.statusCode < 400 && \/\^\\\/api\\\/sync\\\/push/);
  const dec = read('apps/server/src/jobs/ownerAlertsDecision.ts');
  assert.match(dec, /if \(!sendsHeartbeat\(d\)\) return false;/);
  assert.match(read('apps/server/src/jobs/ownerAlertsData.ts'), /last_sync_at, app_version'/);
  // an empty push is cheap: every arm is skipped on an empty list, and last_sync_at is stamped before them
  const sync = read('apps/server/src/routes/sync.ts');
  assert.ok(sync.indexOf('last_sync_at: new Date().toISOString()') < sync.indexOf('if (validDays.length)'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
