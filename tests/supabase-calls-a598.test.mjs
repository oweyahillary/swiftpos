/**
 * supabase-calls-a598.test.mjs — A598: the watchdog's quiet run, 14 Supabase calls → 7 (owner, 2026-10-27: the System
 * page's "Calls a day" card at 24,226 of the 15,000 target; job:watchdog 2,200 a day, the largest source).
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/supabase-calls-a598.test.mjs
 *
 * RUNS the COMPILED server's runWatchdog on the in-memory database (tests/lib-memdb.mjs, every call counted), three runs
 * 10 minutes apart, the way the cron runs it:
 *   1 the billing facts (cloud_plans, business_settings, businesses, feature_flags) kept 30 minutes — they were kept 10,
 *     the watchdog's own interval, so every run found them just expired; forgetStanding (a payment, a plan) reads again
 *   2 the active clients' names kept 30 minutes; a failed read never kept
 *   3 the branch names of open days kept 30 minutes
 *   4 an open problem's "still seen" stamp written once an hour, not every run; a changed detail still written at once
 *   5 A591_MEMO=off: every read every run, as before
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - GOVERNED_QUIET_MS back to 10 minutes                 → 1 "no billing read on the 2nd and 3rd run" fails
 *   - names() without namesKept                            → 2 fails
 *   - seenDue = seenOnly                                   → 4 "no stamp on the 3rd run" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 6).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'jobs/watchdog.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= randomBytes(24).toString('hex');
delete process.env.A591_MEMO;
delete process.env.RESEND_API_KEY; delete process.env.SENDGRID_API_KEY; delete process.env.SMTP_HOST;
delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.ADMIN_ALERT_EMAIL;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const WA = require(path.join(DIST, 'lib/writeActivity.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const W = require(path.join(DIST, 'jobs/watchdog.js'));
const log = console.log;
console.warn = () => {}; console.error = () => {};

const mem = installMemDb(supabase);
const B = '11111111-1111-4111-8111-111111111111', BR = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-10-27T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const BILLING = ['cloud_plans', 'business_settings', 'feature_flags'];

const reset = () => {
  WA._resetWrites(); WA._setTracking(true); WA._setWriteClock(() => T0);
  CP._resetStanding(); W.forgetWatchdogMemory();
  delete process.env.A591_MEMO;
  mem.realOr = true; mem.rowCap = Infinity;
  mem.db = {
    businesses: [{ id: B, name: 'Krunch & Co', status: 'active' }],
    branches: [{ id: BR, business_id: B, name: 'Westlands' }],
    user_devices: [1, 2, 3].map((n) => ({ id: `u${n}`, business_id: B, branch_id: BR, device_id: `d${n}`, status: 'approved', retired_at: null,
      last_seen_at: iso(T0 - 60_000), last_sync_at: iso(T0 - 60_000), app_version: '1.0.22', schema_version: 77 })),
    // a day left open a week ago: one problem that stays open across the runs
    business_days: [{ id: 'bd1', business_id: B, branch_id: BR, device_id: 'd1', terminal_code: 'T1', business_date: '2026-10-20', status: 'open' }],
    ops_events: [{ id: 'o1', kind: 'backup', status: 'ok', created_at: iso(T0 - 3_600_000) }],
    watchdog_alerts: [], admin_settings: [], admin_notifications: [], payments: [], payment_exceptions: [], etims_invoices: [],
    shifts: [], orders: [], business_settings: [], branch_settings: [], cloud_plans: [], feature_flags: [],
  };
};
/** Runs the watchdog at T0 + `min` minutes; the calls it made. */
const runAt = async (min) => { mem.calls = []; await W.runWatchdog(new Date(T0 + min * 60_000)); return mem.calls.map((c) => ({ ...c, key: `${c.table}:${c.op}` })); };
const count = (calls, table, op) => calls.filter((c) => c.table === table && (!op || c.op === op)).length;

log('\nA598 — the watchdog\'s quiet run\n');
await ok('a quiet run after the first: at most 7 calls (14 before)', async () => {
  reset();
  await runAt(0);
  const r2 = await runAt(10), r3 = await runAt(20);
  assert.ok(r2.length <= 8, `2nd run ${r2.length}: ${r2.map((c) => c.key).join(' ')}`);
  assert.ok(r3.length <= 7, `3rd run ${r3.length}: ${r3.map((c) => c.key).join(' ')}`);
});
await ok('1: the billing facts — no billing read on the 2nd and 3rd run; read again after 30 minutes', async () => {
  reset();
  const r1 = await runAt(0);
  assert.ok(BILLING.some((t) => count(r1, t) > 0), 'the first run reads them');
  for (const m of [10, 20]) { const r = await runAt(m); assert.equal(BILLING.reduce((n, t) => n + count(r, t), 0), 0, `run at +${m} min: ${r.map((c) => c.key).join(' ')}`); }
  const r4 = await runAt(30);
  assert.ok(BILLING.some((t) => count(r4, t) > 0), 'kept at most 30 minutes');
});
await ok('1: a payment or plan changed (forgetStanding) — the next run reads the facts again', async () => {
  reset();
  await runAt(0);
  CP.forgetStanding(B);
  const r = await runAt(10);
  assert.ok(BILLING.some((t) => count(r, t) > 0), r.map((c) => c.key).join(' '));
});
await ok('2: the active clients read once in 30 minutes (the DB ping is still every run)', async () => {
  reset();
  await runAt(0);
  const r = await runAt(10);
  assert.equal(count(r, 'businesses', 'select'), 1, 'only the ping: ' + r.map((c) => c.key).join(' '));
  const r4 = await runAt(30);
  assert.equal(count(r4, 'businesses', 'select') >= 2, true, 'read again after 30 minutes');
});
await ok('2: a client renamed shows within 30 minutes', async () => {
  reset();
  await runAt(0);
  mem.db.businesses[0].name = 'Krunch Westlands';
  const later = await W.collectAlerts(new Date(T0 + 31 * 60_000), { load: false });
  assert.ok(later.alerts.some((a) => /Krunch Westlands/.test(`${a.title} ${a.detail ?? ''}`)), later.alerts.map((a) => a.title).join(' | '));
});
await ok('3: the open day\'s branch name read once, then kept', async () => {
  reset();
  const r1 = await runAt(0);
  assert.equal(count(r1, 'branches'), 1);
  const r2 = await runAt(10);
  assert.equal(count(r2, 'branches'), 0, r2.map((c) => c.key).join(' '));
});
await ok('4: an open problem\'s "still seen" stamp — written at most once an hour; a changed detail at once', async () => {
  reset();
  await runAt(0);                                   // opened (inserted)
  const r2 = await runAt(10);                       // first "still open" this server has not stamped: written
  assert.equal(count(r2, 'watchdog_alerts', 'update'), 1, r2.map((c) => c.key).join(' '));
  const r3 = await runAt(20);
  assert.equal(count(r3, 'watchdog_alerts', 'update'), 0, 'no stamp on the 3rd run: ' + r3.map((c) => c.key).join(' '));
  const r9 = await runAt(70);
  assert.equal(count(r9, 'watchdog_alerts', 'update'), 1, 'an hour later: written');
  mem.db.watchdog_alerts[0].detail = 'an older wording';
  const rd = await runAt(80);
  assert.ok(rd.some((c) => c.table === 'watchdog_alerts' && c.op === 'update' && c.filters.id), 'a changed detail: its own update');
});
await ok('5: A591_MEMO=off — every read every run, as before', async () => {
  reset();
  process.env.A591_MEMO = 'off';
  await runAt(0);
  const r = await runAt(10);
  delete process.env.A591_MEMO;
  assert.ok(r.length >= 14, `${r.length}: ${r.map((c) => c.key).join(' ')}`);
});

log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
