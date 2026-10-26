/**
 * admin-alerts-a589.test.mjs — A589: the admin's alerts go to the admin portal first; ONE grouped email, never one per
 * client; system emergencies still emailed at once.
 *
 * Owner, 2026-10-25: "till not closed should not come as an email for each client; let it be a notification on the admin
 * portal — right now I am getting like 7 emails for different clients — or if they must come as an email let it be a
 * table containing the clients list, not each client an email; also invoices let it be the same; [emails] maybe when the
 * server is down or overloaded".
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/admin-alerts-a589.test.mjs
 *
 * RUNS the COMPILED server — jobs/watchdog.js (runWatchdog, sendDigest, sendBillingSummary, claimDigest), the billing job,
 * lib/adminAlertPolicy.js, lib/adminAlerts.js, the admin and ops routers over HTTP — on the in-memory database
 * (tests/lib-memdb.mjs), with the mail provider and Telegram captured:
 *   1 seven clients with a day not closed → 0 emails, 7 bell notifications, ONE Telegram message listing all 7; no
 *     reminder emails 3 hours on; the morning digest: ONE email, ONE table, 7 rows (client | branch / POS | problem | since)
 *   2 invoices and billing notices → no admin email per invoice (the client's own invoice email unchanged), a bell row
 *     each, ONE daily billing summary email with a table (client | invoice | amount | due | status), not repeated
 *   3 system emergencies → an email at once: a 5xx burst, the server overloaded (slow answers / a busy server), the
 *     backup FAILED (ops event) and the backup missed; the database unreachable told ONCE (its own outage), the client
 *     alerts neither resolved nor re-told while it lasts, "resolved" when it is back
 *   4 the settings: a super admin moves "Day not closed" to "at once" → ONE email with a table, not one per client;
 *     nothing at once → no email at all; digest / billing summary off; agents read but cannot change; the digest time
 *   5 the pure rules (routeRun, digestDue, normalizeAlertSettings, categoryOf) and the wiring (pins)
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A589 report):
 *   - isInstant always true                                   → 1 "0 emails" fails
 *   - routeRun pushing a Telegram per alert (no grouping)      → 1 "ONE Telegram message" fails
 *   - digestEmail one table per row                            → 1 "one table, 7 rows" fails
 *   - cloudPlanReminders back to notifyAdmin(…, { email: true }) → 2 "no admin email per invoice" fails
 *   - runWatchdog resolving alerts of a failed check            → 3 "neither resolved nor re-told" fails
 *   - serverOverload threshold check removed (never fires)      → 3 "overloaded" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/adminAlertPolicy.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.ADMIN_ALERT_EMAIL = 'boss@zaptill.test';
process.env.TELEGRAM_BOT_TOKEN = 'tg-test-token';
process.env.TELEGRAM_CHAT_ID = '4242';
process.env.OPS_INGEST_TOKEN = 'x'.repeat(40);
delete process.env.LOGIN_OTP;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
supabase.auth.admin.getUserById = async (uid) => ({ data: { user: { id: uid, email: uid === OWNER ? 'owner@pollo.test' : null } }, error: null });

// The mail provider and Telegram, captured.
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
mailer.sendEmailChecked = async (m) => { mails.push(m); return { ok: true, provider: 'test' }; };
const tg = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.telegram.org/')) { tg.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
  return realFetch(url, init);
};

const W = require(path.join(DIST, 'jobs/watchdog.js'));
const BILL = require(path.join(DIST, 'jobs/cloudPlanReminders.js'));
const P = require(path.join(DIST, 'lib/adminAlertPolicy.js'));
const AA = require(path.join(DIST, 'lib/adminAlerts.js'));
const K = require(path.join(DIST, 'lib/watchdogCounters.js'));
const L = require(path.join(DIST, 'lib/serverLoad.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));

const DAY = 86400000, MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const SUPER = 'aaaaaaaa-0000-4000-8000-0000000000a1', AGENT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const CLIENTS = ['Pollo Grill', 'Mama Duka', 'Kahawa Cafe', 'Shell Kisumu', 'Bora Parking', 'Upendo Salon', 'Neema Mart'];
const bid = (i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`;
const brid = (i) => `22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const reset = () => {
  mem.fail = () => null; mem.calls = []; mails.length = 0; tg.length = 0;
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: CLIENTS.map((name, i) => ({ id: bid(i), name, status: 'active', type: 'retail', currency: 'KES', created_at: '2026-01-01T00:00:00Z' })),
    branches: CLIENTS.map((name, i) => ({ id: brid(i), business_id: bid(i), name: `${name.split(' ')[0]} Main`, is_main: true, status: 'active' })),
    business_days: [], user_devices: [], payments: [], payment_exceptions: [], etims_invoices: [], ops_events: [],
    watchdog_alerts: [], admin_notifications: [], admin_settings: [], admin_audit_log: [],
    business_settings: [], branch_settings: [], feature_flags: [], cloud_plans: [], cloud_plan_reminders: [], invoices: [], cloud_payments: [],
    shifts: [], orders: [],
  };
  W.forgetWatchdogMemory(); AA.forgetAlertSettings(); AA.forgetDigestDate(); K.resetCounters(); CP.forgetStanding(); adminAuth.forgetAdmin();
  L.takeLoopLag();
};
const openDays = (n = 7, date = daysAgo(3)) => {
  for (let i = 0; i < n; i++) mem.db.business_days.push({ id: `day-${i}-${date}`, business_id: bid(i), branch_id: brid(i), device_id: null, terminal_code: `T${i + 1}`, business_date: date, status: 'open' });
};
const adminMails = () => mails.filter((m) => /boss@zaptill\.test/.test(m.to));
// A592: the email's layout is tables too (Gmail) — a DATA table is one with a <thead>.
const tables = (html) => (html.match(/<thead>/g) ?? []).length;
const bodyRows = (html) => (String(html).split('<tbody>')[1] ?? '').split('</tbody>')[0].match(/<tr>/g)?.length ?? 0;
const settle = () => new Promise((r) => setTimeout(r, 60));

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
app.use('/api/ops', require(path.join(DIST, 'routes/ops.js')).default);
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await realFetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const AGENT_T = jwt.sign({ adminId: AGENT, email: 'agent@zaptill.test', role: 'agent' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });

try {
  console.log('\n1. Seven clients with a day not closed\n');
  reset(); openDays(7);
  let r1;
  await ok('one watchdog run: 0 emails, 7 bell notifications, the alerts stored (not "emailed")', async () => {
    r1 = await W.runWatchdog(new Date());
    assert.equal(r1.opened, 7);
    assert.equal(mails.length, 0, mails.map((m) => m.subject).join(' | '));
    const n = mem.db.admin_notifications;
    assert.equal(n.length, 7);
    assert.ok(n.every((x) => x.category === 'day_not_closed' && x.read_at == null));
    assert.deepEqual(new Set(n.map((x) => x.business_id)), new Set(CLIENTS.map((_, i) => bid(i))));
    assert.match(n[0].data.where, /Main \/ T\d/, 'branch / POS');
    assert.equal(mem.db.watchdog_alerts.length, 7);
    assert.ok(mem.db.watchdog_alerts.every((a) => a.notify_count === 0 && a.last_notified_at), 'told (the bell), not emailed');
  });
  await ok('Telegram: ONE message listing all 7 (not seven)', () => {
    assert.equal(tg.length, 1, tg.join('\n---\n'));
    for (const c of CLIENTS) assert.ok(tg[0].includes(c), c);
    assert.match(tg[0], /7 new problems at clients/);
  });
  await ok('the next run says nothing; 3 hours on, still no email and no Telegram reminder (the digest has them)', async () => {
    mails.length = 0; tg.length = 0;
    await W.runWatchdog(new Date());
    await W.runWatchdog(new Date(Date.now() + 181 * MIN));
    assert.equal(mails.length, 0); assert.equal(tg.length, 0);
    assert.equal(mem.db.admin_notifications.length, 7, 'no new bell rows');
  });
  await ok('the morning digest: ONE email, ONE table, 7 rows — client | problem | since | what to do (A592)', async () => {
    mails.length = 0; tg.length = 0;
    const d = await W.sendDigest(new Date());
    assert.equal(d.emailed, true);
    const m = adminMails();
    assert.equal(m.length, 1);
    assert.match(m[0].subject, /Daily check · .* — 7 open problems/);   // A592
    assert.equal(tables(m[0].html), 1);
    assert.equal(bodyRows(m[0].html), 7);
    for (const h of ['Client', 'Problem', 'Since', 'What to do']) assert.ok(m[0].html.includes(`>${h}</th>`), h);   // A592: the owner's four columns
    assert.ok(m[0].html.includes('Close it at the POS or by Remote Day Close'), 'the recommendation column');
    for (const c of CLIENTS) assert.ok(m[0].html.includes(c), c);
    assert.match(m[0].html, />Day not closed \(T\d\)</);   // A592: "Day not closed (T1)", since the day ended ("3 days")
    assert.match(m[0].html, />[23] days</);
    assert.equal(tg.length, 1, 'the digest text on Telegram, as before');
  });
  await ok('nothing open → the digest sends no email (Telegram still says all is well)', async () => {
    reset();
    const d = await W.sendDigest(new Date());
    assert.equal(d.emailed, false); assert.equal(mails.length, 0);
    assert.match(tg[0], /All clients look healthy/);
  });
  await ok('the digest is due once a Nairobi day, at the settings\' time, within 3 hours of it', async () => {
    const at = (h, m) => new Date(Date.UTC(2026, 9, 26, h - 3, m));   // Nairobi h:m
    assert.equal(P.digestDue(at(6, 59), '07:00', null), false);
    assert.equal(P.digestDue(at(7, 0), '07:00', null), true);
    assert.equal(P.digestDue(at(7, 5), '07:00', '2026-10-26'), false, 'already sent today');
    assert.equal(P.digestDue(at(9, 59), '07:00', '2026-10-25'), true);
    assert.equal(P.digestDue(at(15, 0), '07:00', '2026-10-25'), false, 'not in the afternoon after a restart');
    assert.equal(P.digestDue(at(0, 20), '00:15', null), true, 'just after midnight Nairobi = the same Nairobi day');
    reset();
    const now = new Date(); const { minutes } = P.nairobiClock(now);
    const t = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    mem.db.admin_settings.push({ key: 'alert_settings', value: { digestTime: t } }); AA.forgetAlertSettings();
    assert.equal(await W.claimDigest(now), true);
    assert.equal(await W.claimDigest(now), false, 'once');
    AA.forgetDigestDate();
    assert.equal(await W.claimDigest(now), false, 'once — across a restart (admin_settings digest_state)');
  });

  console.log('\n2. Invoices and billing notices\n');
  const M = bid(0);
  const billingSetup = () => {
    reset();
    mem.db.businesses = [{ id: M, name: 'Pollo Grill', owner_id: OWNER, email: 'shop@pollo.test', status: 'active', type: 'restaurant', currency: 'KES',
      web_access_expires_at: iso(Date.now() - 3600_000), created_at: '2026-01-01T00:00:00Z' }];
    mem.db.cloud_plans = [{ business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss', created_at: '2026-01-01T00:00:00.000Z' }];
    mem.db.feature_flags = [{ business_id: M, key: 'web_hosting', enabled: true }];
    mem.db.users = [{ id: OWNER, business_id: M, name: 'Owner', status: 'active', permissions_version: 0 }];
    CP.forgetStanding();
  };
  await ok('an invoice: the client gets it; ZapTill gets NO email — a bell row with the invoice, amount, due, status', async () => {
    billingSetup();
    const out = await BILL.runCloudBilling(new Date(), { force: true });
    assert.ok(out.sent.some((x) => x.milestone === 'invoice' && x.owner && x.admin), JSON.stringify(out.sent));
    assert.equal(mails.filter((m) => m.to === 'owner@pollo.test').length, 1, 'the client\'s own invoice email is unchanged');
    assert.equal(adminMails().length, 0, mails.map((m) => `${m.to}: ${m.subject}`).join(' | '));
    assert.equal(tg.length, 0, 'no Telegram per invoice either');
    const n = mem.db.admin_notifications.filter((x) => x.category === 'billing');
    assert.equal(n.length, 1);
    const inv = mem.db.invoices[0];
    assert.deepEqual([n[0].data.invoice, n[0].data.amount, n[0].data.currency, n[0].data.milestone], [inv.invoice_number, 3000, 'KES', 'invoice']);
    assert.match(n[0].data.status, /^Invoice issued/);
    assert.equal(mem.db.cloud_plan_reminders[0].admin_sent, true, 'recorded as told (the bell)');
  });
  await ok('the daily billing summary: ONE email, one table — client | problem (status, invoice, amount) | since | what to do; marked, not repeated', async () => {
    mails.length = 0;
    const s = await W.sendBillingSummary(new Date());
    assert.equal(s.emailed, true);
    const m = adminMails(); assert.equal(m.length, 1);
    assert.match(m[0].subject, /Billing summary · .* — 1 notice/);   // A592
    assert.equal(tables(m[0].html), 1); assert.equal(bodyRows(m[0].html), 1, 'the client once (its notice), not again as "unpaid"');
    for (const h of ['Client', 'Problem', 'Since', 'What to do']) assert.ok(m[0].html.includes(`>${h}</th>`), h);   // A592
    assert.ok(m[0].html.includes(mem.db.invoices[0].invoice_number)); assert.ok(m[0].html.includes('KES 3,000'));
    assert.ok(mem.db.admin_notifications.every((x) => x.digest_sent_at), 'marked as summarised');
    mails.length = 0;
    await W.sendBillingSummary(new Date());
    const again = adminMails();
    assert.ok(!again.length || !again[0].html.includes(mem.db.invoices[0].invoice_number), 'the notice is not repeated (an unpaid client may still be listed)');
  });
  await ok('the lock and day 5: bell rows, no admin email; the summary lists them', async () => {
    billingSetup();
    const noon = Date.now();
    mem.db.businesses[0].web_access_expires_at = iso(noon - 10 * DAY); CP.forgetStanding();
    await BILL.runCloudBilling(new Date(noon), { force: true });
    assert.equal(adminMails().length, 0);
    const ms = mem.db.admin_notifications.map((x) => x.data.milestone).sort();
    assert.ok(ms.includes('locked'), ms.join(','));
    mails.length = 0;
    await W.sendBillingSummary(new Date());
    assert.match(adminMails()[0].html, /Locked \(unpaid 7 days\)/);
  });

  console.log('\n3. System emergencies — email at once\n');
  await ok('a burst of server errors: one email at once (+ Telegram), reminded after 3 hours, not before', async () => {
    reset();
    for (let i = 0; i < 12; i++) K.recordServerError('/api/sync/push');
    await W.runWatchdog(new Date());
    const m = adminMails();
    assert.equal(m.length, 1); assert.match(m[0].subject, /^🔴 Cloud: 12 server errors in 5 min/);   // A592
    assert.equal(mem.db.watchdog_alerts[0].notify_count, 1);
    assert.ok(tg.some((t) => /server errors/.test(t)));
    mails.length = 0;
    await W.runWatchdog(new Date(Date.now() + 2 * MIN));
    assert.equal(adminMails().length, 0, 'not every 10 minutes');
  });
  await ok('overloaded — slow answers (p95 ≥ 5 s over 30+ requests): an email at once', async () => {
    reset();
    for (let i = 0; i < 40; i++) K.recordRequestDuration(i < 30 ? 6500 : 200);
    await W.runWatchdog(new Date());
    const m = adminMails();
    assert.equal(m.length, 1, mails.map((x) => x.subject).join(' | ')); assert.match(m[0].subject, /Cloud overloaded: slow answers/);
    assert.match(m[0].html, /95% within 6\.5 s over 40 requests/);
  });
  await ok('overloaded — a busy server (event loop late by 1.5 s): an email at once; a quiet one says nothing', async () => {
    reset();
    for (let i = 0; i < 50; i++) L.recordLoopDelay(i === 49 ? 1500 : 3);
    await W.runWatchdog(new Date());
    assert.equal(adminMails().length, 1); assert.match(adminMails()[0].subject, /Cloud overloaded: the server is busy/);
    reset();
    for (let i = 0; i < 40; i++) K.recordRequestDuration(120);
    for (let i = 0; i < 50; i++) L.recordLoopDelay(4);
    await W.runWatchdog(new Date());
    assert.equal(mails.length, 0);
  });
  await ok('the nightly backup FAILED (the workflow\'s ops event): an email at once and a bell row', async () => {
    reset();
    const r = await call('POST', '/api/ops/events', 'x'.repeat(40), { kind: 'backup', status: 'fail', title: 'Backup FAILED — failed while dumping the database (exit 1)', details: { error: 'failed while dumping the database (exit 1)' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await settle();
    const m = adminMails(); assert.equal(m.length, 1); assert.match(m[0].subject, /^🔴 Backup failed · /);   // A592
    assert.match(m[0].html, /dumping the database \(exit 1\)/);
    assert.equal(mem.db.admin_notifications.filter((n) => n.category === 'backup').length, 1);
    mails.length = 0;
    assert.equal((await call('POST', '/api/ops/events', 'x'.repeat(40), { kind: 'backup', status: 'ok', title: 'Backup OK — 48.2 MB, 37 s', details: { size_bytes: 50_000_000 } })).status, 201);
    await settle();
    assert.equal(mails.length, 0, 'a good backup is not emailed');
  });
  await ok('the backup missed (no good one for 8 days, weekly - A591): an email at once; none recorded ever: quiet', async () => {
    reset();
    await W.runWatchdog(new Date());
    assert.equal(mails.length, 0, 'no backup ever recorded: nothing to say');
    mem.db.ops_events.push({ id: 'b1', kind: 'backup', status: 'ok', title: 'Backup OK', created_at: iso(Date.now() - 9 * 24 * 3600_000) });
    await W.runWatchdog(new Date());
    assert.equal(adminMails().length, 1); assert.match(adminMails()[0].subject, /Backup: no good backup for/);
    reset();
    mem.db.ops_events.push({ id: 'b2', kind: 'backup', status: 'ok', title: 'Backup OK', created_at: iso(Date.now() - 6 * 24 * 3600_000) });
    await W.runWatchdog(new Date());
    assert.equal(mails.length, 0);
  });
  await ok('the database unreachable: told ONCE; the client alerts neither resolved nor re-told; "resolved" when it is back', async () => {
    reset(); openDays(7);
    await W.runWatchdog(new Date());
    mails.length = 0; tg.length = 0;
    const down = (table) => table === 'businesses' || table === 'watchdog_alerts';
    mem.fail = (table) => (down(table) ? { message: 'connection refused' } : null);
    await W.runWatchdog(new Date());
    assert.equal(adminMails().length, 1); assert.match(adminMails()[0].subject, /the database is unreachable/);
    await W.runWatchdog(new Date(Date.now() + 10 * MIN));
    assert.equal(adminMails().length, 1, 'once, not every 10 minutes (kept in memory while the table cannot be written)');
    mem.fail = () => null; tg.length = 0; mails.length = 0;
    const back = await W.runWatchdog(new Date(Date.now() + 20 * MIN));
    assert.equal(back.opened, 0, 'the 7 days are not "new" again');
    assert.equal(mem.db.watchdog_alerts.filter((a) => a.alert_key.startsWith('day_not_closed') && !a.resolved_at).length, 7, 'still open');
    assert.equal(mails.length, 0);
    assert.equal(tg.length, 1); assert.match(tg[0], /^✅ <b>Resolved after [^<]+<\/b>\nCloud: the database is unreachable/);   // A592
    assert.equal(mem.db.admin_notifications.filter((n) => n.category === 'day_not_closed').length, 7, 'no second bell row');
  });

  await ok('one check\'s read fails (the days): its alerts are neither resolved nor told again as new when it reads again', async () => {
    reset(); openDays(7);
    await W.runWatchdog(new Date());
    tg.length = 0; mails.length = 0;
    mem.fail = (table, op) => (table === 'business_days' && op === 'select' ? { message: 'statement timeout', code: '57014' } : null);
    const r = await W.runWatchdog(new Date(Date.now() + 10 * MIN));
    assert.equal(r.resolved, 0);
    assert.equal(mem.db.watchdog_alerts.filter((a) => !a.resolved_at).length, 7, 'still open');
    assert.equal(tg.length, 0, 'no "resolved" message');
    mem.fail = () => null;
    const again = await W.runWatchdog(new Date(Date.now() + 20 * MIN));
    assert.equal(again.opened, 0, 'not new again');
    assert.equal(mem.db.admin_notifications.length, 7, 'no second bell row');
  });

  console.log('\n4. The settings (Alerts › Email settings)\n');
  await ok('read by every admin; changed by a super admin only (audited); a bad time or category refused', async () => {
    reset();
    const g = await call('GET', '/api/admin/alert-settings', AGENT_T);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.settings, P.DEFAULT_ALERT_SETTINGS);
    assert.ok(g.body.categories.some((c) => c.id === 'day_not_closed' && c.group === 'client' && !c.instantDefault));
    assert.equal((await call('PUT', '/api/admin/alert-settings', AGENT_T, { digestEmail: false })).status, 403);
    assert.equal((await call('PUT', '/api/admin/alert-settings', ADMIN, { digestTime: '7am' })).status, 400);
    assert.equal((await call('PUT', '/api/admin/alert-settings', ADMIN, { instant: ['nope'] })).status, 400);
    const p = await call('PUT', '/api/admin/alert-settings', ADMIN, { digestTime: '06:30' });
    assert.equal(p.status, 200); assert.equal(p.body.settings.digestTime, '06:30');
    assert.equal(mem.db.admin_settings.find((s) => s.key === 'alert_settings').value.digestTime, '06:30');
    assert.ok(mem.db.admin_audit_log.some((a) => a.action === 'alert_settings.update'));
  });
  await ok('"Day not closed" at once: ONE email with a table of the 7 — never one email per client', async () => {
    reset();
    await call('PUT', '/api/admin/alert-settings', ADMIN, { instant: [...P.DEFAULT_ALERT_SETTINGS.instant, 'day_not_closed'] });
    openDays(7);
    await W.runWatchdog(new Date());
    const m = adminMails();
    assert.equal(m.length, 1, m.map((x) => x.subject).join(' | '));
    assert.match(m[0].subject, /ZapTill: 7 client problems/);
    assert.equal(tables(m[0].html), 1); assert.equal(bodyRows(m[0].html), 7);
    assert.ok(mem.db.watchdog_alerts.every((a) => a.notify_count === 1), 'counted as emailed');
    assert.equal(mem.db.admin_notifications.length, 7, 'the bell too');
  });
  await ok('nothing at once: a 5xx burst reaches Telegram and the bell, not the email; digest and billing summary off: no email', async () => {
    reset();
    await call('PUT', '/api/admin/alert-settings', ADMIN, { instant: [], digestEmail: false, billingSummaryEmail: false });
    for (let i = 0; i < 12; i++) K.recordServerError('/api/orders');
    openDays(2);
    await W.runWatchdog(new Date());
    assert.equal(mails.length, 0);
    assert.equal(tg.length, 1); assert.match(tg[0], /3 new problems/);
    assert.equal(mem.db.admin_notifications.length, 3);
    assert.equal((await W.sendDigest(new Date())).emailed, false);
    mem.db.admin_notifications.push({ id: 'n1', category: 'billing', title: 'x', data: { client: 'A', status: 'Locked' }, created_at: iso(Date.now()) });
    assert.equal((await W.sendBillingSummary(new Date())).emailed, false);
    assert.equal(mails.length, 0);
  });
  await ok('the bell over HTTP: unread count, mark one, mark all', async () => {
    reset(); openDays(3);
    await W.runWatchdog(new Date());
    const b = await call('GET', '/api/admin/notifications', AGENT_T);
    assert.equal(b.status, 200); assert.equal(b.body.unread, 3); assert.equal(b.body.notifications.length, 3);
    const id = b.body.notifications[0].id;
    assert.equal((await call('POST', '/api/admin/notifications/read', AGENT_T, { ids: [id] })).status, 200);
    assert.equal((await call('GET', '/api/admin/notifications?unread=1', AGENT_T)).body.unread, 2);
    assert.equal(mem.db.admin_notifications.find((n) => n.id === id).read_by, 'agent@zaptill.test');
    assert.equal((await call('POST', '/api/admin/notifications/read', AGENT_T, {})).status, 400);
    await call('POST', '/api/admin/notifications/read', ADMIN, { all: true });
    assert.equal((await call('GET', '/api/admin/notifications', ADMIN)).body.unread, 0);
    assert.equal((await call('GET', '/api/admin/notifications')).status, 401);
  });

  console.log('\n5. The rules and the wiring\n');
  await ok('categories: client problems digest-only by default, system ones at once; unknown keys are system', () => {
    for (const k of ['day_not_closed:x', 'till_not_syncing:x', 'till_signed_out:x', 'sync_refused:x', 'mpesa_unanswered:b', 'payment_exception:b', 'etims_failed:b', 'old_tills:b', 'till_parked:x']) {
      assert.equal(P.groupOf(k), 'client', k); assert.equal(P.isInstant(k, P.DEFAULT_ALERT_SETTINGS), false, k);
    }
    for (const k of ['server_errors', 'server_overload', 'database_unreachable', 'signin_failures:admin:a', 'signin_failures_ip:1.2.3.4', 'backup_missed', 'backup_failed', 'something_new']) {
      assert.equal(P.groupOf(k), 'system', k); assert.equal(P.isInstant(k, P.DEFAULT_ALERT_SETTINGS), true, k);
    }
    assert.equal(P.DEFAULT_ALERT_SETTINGS.digestTime, '07:00');
    assert.deepEqual(P.normalizeAlertSettings({ instant: ['day_not_closed', 'bogus'], digestTime: '25:00', digestEmail: 'yes' }),
      { instant: ['day_not_closed'], digestEmail: true, digestTime: '07:00', billingSummaryEmail: true });
  });
  await ok('routeRun: system one each; client ones ONE grouped email when at once, else ONE Telegram; the bell for every new one', () => {
    const now = new Date();
    const a = (key, client) => ({ alert: { key, severity: 'critical', businessId: client ? 'b' : null, title: client ? `${client}: day 2026-10-24 not closed` : 'Cloud: 12 server errors in 5 min' }, firstSeenAt: now.toISOString() });
    const r = P.routeRun({ opened: [a('server_errors'), a('day_not_closed:1', 'A'), a('day_not_closed:2', 'B')], reminders: [], resolved: [] }, P.DEFAULT_ALERT_SETTINGS, now);
    assert.equal(r.instantEach.length, 1); assert.equal(r.instantGroup, null);
    assert.match(r.telegramGroup.text, /2 new problems at clients/); assert.equal(r.notifications.length, 3);
    const s = { ...P.DEFAULT_ALERT_SETTINGS, instant: [...P.DEFAULT_ALERT_SETTINGS.instant, 'day_not_closed'] };
    const r2 = P.routeRun({ opened: [a('day_not_closed:1', 'A'), a('day_not_closed:2', 'B')], reminders: [a('day_not_closed:3', 'C')], resolved: [] }, s, now);
    assert.deepEqual(r2.instantGroup.keys, ['day_not_closed:1', 'day_not_closed:2', 'day_not_closed:3']);
    assert.match(r2.instantGroup.subject, /3 client problems \(2 new\)/);
    const r3 = P.routeRun({ opened: [], reminders: [a('day_not_closed:3', 'C')], resolved: [] }, P.DEFAULT_ALERT_SETTINGS, now);
    assert.deepEqual(r3.quiet, ['day_not_closed:3']); assert.equal(r3.telegramGroup, null);
  });
  await ok('the wiring: digest at the settings\' time, the billing job writes the bell (no notifyAdmin), the bell in the portal header', () => {
    const j = read('apps/server/src/jobs/watchdog.ts');
    assert.match(j, /if \(await claimDigest\(\)\) await sendMorning\(\)/);
    assert.match(j, /startLoopMonitor\(\);/);
    const b = read('apps/server/src/jobs/cloudPlanReminders.ts');
    assert.doesNotMatch(b, /notifyAdmin\(/, 'no admin email per invoice');
    assert.match(b, /addAdminNotifications\(\[\{\s*category: 'billing'/);
    const idx = read('apps/server/src/index.ts');
    assert.match(idx, /recordRequestDuration\(Date\.now\(\) - startedAt\)/);
    const portal = read('apps/admin/src/AdminPortal.tsx');
    assert.match(portal, /<NotificationBell req=\{req\} enabled=\{Boolean\(token && admin\)\}/);
    assert.match(read('apps/admin/src/AlertsPage.tsx'), /<EmailSettingsCard req=\{req\} isSuper=\{isSuper\} \/>/);
    assert.match(read('apps/admin/src/SystemPage.tsx'), /data-testid="card-backup"/);
    assert.match(read('migrations/174_admin_alerts.sql'), /CREATE TABLE IF NOT EXISTS public\.admin_notifications/);
  });
} finally {
  server.close();
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
