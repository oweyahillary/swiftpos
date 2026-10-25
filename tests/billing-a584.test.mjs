/**
 * billing-a584.test.mjs — A584: one set of billing rules for EVERY business with an expiry date; the invoice on the first
 * day of each billing period; the lock 7 days after the due date (end of day 7, Nairobi) with no warning to the client;
 * reminders to ZapTill only; a recorded payment restores everything at once.
 *
 * Owner, 2026-10-23: "build a robust structure — some clients I had already set the licence, but build it: if it expires
 * they will call" · "an invoice is sent to the client on the first day of their billing" · "without informing them when
 * the access will be revoked" · "after 7 days the access gets revoked immediately, no warning for web".
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/billing-a584.test.mjs
 *
 * RUNS the COMPILED server — lib/billingClock.js, lib/cloudPlan.js, lib/webAccess.js, lib/cloudPlanEmail.js, the billing
 * job, and the real auth middleware (both gates), admin, cloud-plan admin, auth (enrolment) and business routers over HTTP
 * on the in-memory database (tests/lib-memdb.mjs) — and the dashboard's / admin portal's words from their TypeScript:
 *   1 the clock: the lock exactly at 00:00 Nairobi after the 7th unpaid day; no grace or reports-only for a paid client;
 *     invoice periods (monthly, 12 months, month ends); the bridge's period; a payment within the 7 days covers the
 *     invoiced period
 *   2 the invoice on the due day (monthly and 12 months): once per period (idempotent — even with the claim lost), the
 *     client's email has no word of a lock, ZapTill's copy
 *   3 the bridge: a dated licence with no plan is put on one (12 months, KES 36,000, audited) and invoiced from the bridge
 *     day — never locked by the deploy; web access on with no expiry → unchanged, listed "No expiry set"; switched off →
 *     not billed
 *   4 admin-only notices: day 5 ("locks in 2 days"), the lock (once), the morning digest's locked list; never to the client
 *   5 the lock over HTTP: web paused (403 CLOUD_ACCESS_PAUSED, reads too; /api/auth open), till writes 503, no till joins;
 *     a payment restores all at once, covers the invoiced period, marks the invoice paid, a receipt
 *   6 "Enable web access" retired (409, no KES 10,000 invoice); the complimentary paid-until (super admin, a reason, audited)
 *   7 shown: the paused screen and sign-in card, no dashboard notice, the admin list's statuses
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A584 report):
 *   - lockAtFor with UNPAID_DAYS instead of UNPAID_DAYS + 1          → 1 "the lock exactly" fails
 *   - lockAtFor from the due moment, not the Nairobi day start        → 1 "the lock exactly" fails
 *   - the bridge's billing floor removed (billingFrom null)           → 1 "bridge", 3 "never locked by the deploy" fail
 *   - the invoice existence check removed from the job               → 2 "once per period" fails
 *   - adminMilestones without unpaid_5                                → 4 "day 5" fails
 *   - webGateApplies always false                                     → 5 "web paused" fails
 *   - nextPaidUntil ignoring continueFrom                             → 1 "covers the invoiced period", 5 "covers" fail
 *   - forgetStanding dropped from Record payment                      → 5 "restores at once" fails
 *   - the WEB_ACCESS_BY_PLAN refusal removed                          → 6 "retired" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installMemDb } from './lib-memdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 4).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/billingClock.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.ADMIN_JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.SUPABASE_JWT_SECRET ??= crypto.randomBytes(24).toString('hex');
process.env.ADMIN_ALERT_EMAIL = 'billing@zaptill.test';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.LOGIN_OTP;
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const jwt = require('jsonwebtoken');
const { supabase } = require(path.join(DIST, 'lib/supabase.js'));
const mem = installMemDb(supabase);
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
supabase.auth.admin.getUserById = async (uid) => ({ data: { user: { id: uid, email: uid === OWNER ? 'owner@pollo.test' : null } }, error: null });
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
mailer.sendEmailChecked = async (m) => { mails.push(m); return { ok: true, provider: 'test' }; };
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const { requireAuth } = require(path.join(DIST, 'middleware/auth.js'));
const BC = require(path.join(DIST, 'lib/billingClock.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const W = require(path.join(DIST, 'lib/webAccess.js'));
const EM = require(path.join(DIST, 'lib/cloudPlanEmail.js'));
const JOB = require(path.join(DIST, 'jobs/cloudPlanReminders.js'));
const N = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/cloudTrialNotice.ts')).href);
const PZ = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/cloudPaused.ts')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/cloudPlan.ts')).href);

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const SUPER = 'aaaaaaaa-0000-4000-8000-0000000000a1', AGENT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const M = '11111111-1111-4111-8111-111111111111';    // a monthly plan (Pollo)
const Y = '11111111-1111-4111-8111-111111111112';    // a 12-month plan
const LG = '11111111-1111-4111-8111-111111111113';   // a legacy licence: dated, no plan
const NE = '11111111-1111-4111-8111-111111111114';   // web access on, no expiry
const OFF = '11111111-1111-4111-8111-111111111115';  // switched off, a date kept, no plan
const MR = '22222222-2222-4222-8222-222222222221';
const CODE = 'ABCD-EFGH';
const hash = (c) => crypto.createHash('sha256').update(c).digest('hex');
const biz = (id = M) => mem.db.businesses.find((b) => b.id === id);
const setPaidUntil = (ms, id = M) => { biz(id).web_access_expires_at = ms === null ? null : iso(ms); CP.forgetStanding(); };
const LONG_AGO = '2026-01-01T00:00:00.000Z';
const reset = () => {
  mem.fail = () => null; mem.calls = []; mails.length = 0;
  const now = Date.now();
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [
      { id: M, name: 'Pollo <b>Grill</b>', owner_id: OWNER, email: 'shop@pollo.test', status: 'active', type: 'restaurant', currency: 'KES', web_access_expires_at: iso(now - 3600_000), created_at: '2026-01-01T00:00:00Z' },
      { id: Y, name: 'Year Duka', owner_id: 'y', email: 'year@duka.test', status: 'active', type: 'retail', currency: 'KES', web_access_expires_at: iso(now - 3600_000), created_at: '2026-01-01T00:00:00Z' },
      { id: LG, name: 'Legacy Parking', owner_id: 'l', email: 'legacy@park.test', status: 'active', type: 'parking', currency: 'KES', web_access_expires_at: iso(now - 20 * DAY), created_at: '2025-06-01T00:00:00Z' },
      { id: NE, name: 'No Date Salon', owner_id: 'n', email: 'nd@salon.test', status: 'active', type: 'other', currency: 'KES', web_access_expires_at: null, created_at: '2025-06-01T00:00:00Z' },
      { id: OFF, name: 'Off Kiosk', owner_id: 'o', email: 'off@kiosk.test', status: 'active', type: 'retail', currency: 'KES', web_access_expires_at: iso(now - 3 * DAY), created_at: '2025-06-01T00:00:00Z' },
    ],
    branches: [{ id: MR, business_id: M, name: 'Main', is_main: true, status: 'active', desktop_licensed: true }],
    cloud_plans: [
      { business_id: M, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss@zaptill.test', created_at: LONG_AGO },
      { business_id: Y, period: '12_months', amount: 36000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss@zaptill.test', created_at: LONG_AGO },
    ],
    business_settings: [],
    feature_flags: [
      { business_id: M, key: 'web_hosting', enabled: true }, { business_id: Y, key: 'web_hosting', enabled: true },
      { business_id: LG, key: 'web_hosting', enabled: true }, { business_id: NE, key: 'web_hosting', enabled: true },
      { business_id: OFF, key: 'web_hosting', enabled: false },
    ],
    user_devices: [{ id: 'ud1', business_id: M, device_id: 'till-M', status: 'approved', retired_at: null, branch_id: MR },
      { id: 'ud2', business_id: LG, device_id: 'till-LG', status: 'approved', retired_at: null, branch_id: null }],
    device_enrolment_codes: [{ id: 'ec1', business_id: M, branch_id: MR, code_hash: hash(CODE), status: 'active', expires_at: iso(now + 600_000) }],
    cloud_payments: [], cloud_plan_reminders: [], invoices: [], admin_audit_log: [], subscriptions: [], plans: [],
    users: [{ id: OWNER, business_id: M, name: 'Owner', status: 'active', permissions_version: 0 }],
    refresh_tokens: [], products: [], orders: [], notifications: [],
  };
  adminAuth.forgetAdmin();
  CP.forgetStanding();
};
reset();

const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/admin/clients', require(path.join(DIST, 'routes/cloudPlanAdmin.js')).default);
app.use('/api/admin', require(path.join(DIST, 'routes/admin.js')).default);
app.use('/api/auth', require(path.join(DIST, 'routes/auth.js')).default);
app.use('/api/business', require(path.join(DIST, 'routes/business.js')).default);
app.post('/api/sync/push', requireAuth, (_req, res) => res.json({ ok: true, upserted: {}, rejected: [] }));
app.get('/api/reports/daily', requireAuth, (_req, res) => res.json({ total: 1 }));
app.post('/api/expenses', requireAuth, (_req, res) => res.status(201).json({ ok: true }));
app.post('/api/auth/logout-standin', requireAuth, (_req, res) => res.json({ ok: true }));
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const AGENT_T = jwt.sign({ adminId: AGENT, email: 'agent@zaptill.test', role: 'agent' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const till = (businessId, deviceId, branchId) => jwt.sign({ userId: null, deviceId, till: true, businessId, branchId, isOwner: false,
  permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TILL_M = till(M, 'till-M', MR), TILL_LG = till(LG, 'till-LG', null);
const web = (businessId) => jwt.sign({ userId: OWNER, businessId, branchId: null, isOwner: true, ownerLogin: true, surface: 'dashboard', permissionKeys: ['*'],
  permissionsVersion: 0, sessionId: 's' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const OWNER_WEB = web(M);
const pay = (id, body, token = ADMIN) => call('POST', `/api/admin/clients/${id}/cloud-plan/payments`, token, body);
const run = (now = new Date()) => JOB.runCloudBilling(now, { force: true });
const NO_REVOKE = /lock|revok|paus|suspend|stop|grace|expir|cut off|disabl|deadline|overdue|7 days|seven|until|access will|warn/i;
const stripTags = (h) => h.replace(/<[^>]+>/g, ' ');

try {
  console.log('\n1. The clock\n');
  await ok('the lock exactly at 00:00 Nairobi after the 7th unpaid day (due 23 Nov → open to 23:59:59 on 30 Nov, locked from 1 Dec)', () => {
    const due = '2026-11-23T07:00:00.000Z';                       // 10:00 Nairobi, 23 Nov
    assert.equal(BC.lockAtFor(due), '2026-11-30T21:00:00.000Z');   // 00:00 Nairobi, 1 Dec
    assert.equal(BC.paidState(due, Date.parse('2026-11-23T06:59:59Z')), 'active');
    assert.equal(BC.paidState(due, Date.parse('2026-11-23T07:00:00Z')), 'unpaid');
    assert.equal(BC.paidState(due, Date.parse('2026-11-30T20:59:59Z')), 'unpaid', '23:59:59 Nairobi on day 7');
    assert.equal(BC.paidState(due, Date.parse('2026-11-30T21:00:00Z')), 'locked', '00:00 Nairobi on day 8');
    // the Nairobi day decides, not the UTC one: 23:30 Nairobi on 23 Nov (20:30 UTC) is still day 0
    assert.equal(BC.lockAtFor('2026-11-23T20:30:00.000Z'), '2026-11-30T21:00:00.000Z');
    // 00:30 Nairobi on 24 Nov (21:30 UTC on the 23rd) is day 0 of the 24th
    assert.equal(BC.lockAtFor('2026-11-23T21:30:00.000Z'), '2026-12-01T21:00:00.000Z');
    assert.deepEqual([0, 3, 5, 7].map((d) => BC.unpaidDaysAt(due, Date.parse(due) + d * DAY)), [0, 3, 5, 7]);
  });
  await ok('no grace and no reports-only stage for a paid client: full access to the lock, then locked (web and sync together)', () => {
    const now = Date.now();
    for (let d = 0; d <= 40; d++) {
      const f = { onPlan: true, planCreatedAt: LONG_AGO, trial: null, expiresAt: iso(now - d * DAY), webHosting: true };
      const w = W.webAccessFor(f, now), s = CP.cloudStanding(f, now);
      assert.notEqual(w.state, 'reports_only', `day ${d}`);
      assert.equal(w.canLogin, !s.webLocked, `day ${d}`); assert.equal(s.syncRefused, s.webLocked, `day ${d}`);
      if (d <= 6) assert.equal(w.fullAccess, true, `day ${d}`);
      if (d >= 9) assert.equal(w.state, 'locked', `day ${d}`);
    }
    assert.equal(W.GRACE_DAYS, 7);
  });
  await ok('invoice periods: monthly and 12 months, held to the month end (31 Jan → 28 Feb; 29 Feb 2028 + 12 → 28 Feb 2029)', () => {
    const m = CP.invoicePeriod({ period: 'monthly', amount: 3000 }, '2027-01-31T07:00:00.000Z');
    assert.deepEqual([m.start, m.end, m.amount], ['2027-01-31T07:00:00.000Z', '2027-02-28T07:00:00.000Z', 3000]);
    const y = CP.invoicePeriod({ period: '12_months', amount: 36000 }, '2028-02-29T07:00:00.000Z');
    assert.deepEqual([y.end, y.amount], ['2029-02-28T07:00:00.000Z', 36000]);
    assert.equal(CP.invoicePeriod(null, '2026-11-23T07:00:00.000Z').amount, 3000, 'no plan: KES 3,000 a month');
  });
  await ok('the bridge: the period from the last invoice (else 12 months); a plan made after the date moves the due day to it', () => {
    assert.equal(CP.inferBridgePeriod(null), '12_months');
    assert.equal(CP.inferBridgePeriod({ period_start: '2026-01-01T00:00:00Z', period_end: '2027-01-01T00:00:00Z' }), '12_months');
    assert.equal(CP.inferBridgePeriod({ period_start: '2026-01-01T00:00:00Z', period_end: '2026-02-01T00:00:00Z' }), 'monthly');
    assert.equal(CP.inferBridgePeriod({ period_start: '2026-01-01T00:00:00Z', period_end: '2026-07-01T00:00:00Z' }), '6_months');
    const now = Date.now();
    const pending = CP.cloudStanding({ onPlan: false, trial: null, expiresAt: iso(now - 400 * DAY), webHosting: true }, now);
    assert.equal(pending.bridgePending, true); assert.equal(pending.syncRefused, false); assert.equal(pending.webLocked, false);
    const bridged = CP.cloudStanding({ onPlan: true, planCreatedAt: iso(now - 2 * DAY), trial: null, expiresAt: iso(now - 400 * DAY), webHosting: true }, now);
    assert.equal(bridged.state, 'unpaid'); assert.equal(bridged.dueAt, iso(now - 2 * DAY)); assert.equal(bridged.unpaidDays, BC.nairobiDay(now) - BC.nairobiDay(now - 2 * DAY));
    const ne = CP.cloudStanding({ onPlan: false, trial: null, expiresAt: null, webHosting: true }, now);
    assert.deepEqual([ne.state, ne.gated, ne.syncRefused, ne.webLocked], ['no_expiry', false, false, false]);
  });
  await ok('a payment within the 7 days covers the invoiced period (due 23 Nov, paid 28 Nov → 23 Dec); early adds on; locked starts today', () => {
    const now = Date.parse('2026-11-28T09:00:00Z');
    const within = CP.nextPaidUntil({ period: 'monthly', now, paidUntil: '2026-11-23T07:00:00.000Z', continueFrom: '2026-11-23T07:00:00.000Z' });
    assert.deepEqual([within.from, within.until], ['2026-11-23T07:00:00.000Z', '2026-12-23T07:00:00.000Z']);
    assert.equal(CP.nextPaidUntil({ period: 'monthly', now, paidUntil: '2026-12-05T07:00:00.000Z', continueFrom: null }).until, '2027-01-05T07:00:00.000Z');
    assert.equal(CP.nextPaidUntil({ period: 'monthly', now, paidUntil: '2026-10-01T07:00:00.000Z', continueFrom: null }).from, iso(now));
  });

  console.log('\n2. The invoice on the first day of the period\n');
  await ok('the due day: a pending cloud invoice for the period (monthly KES 3,000, 12 months KES 36,000) and the client\'s email', async () => {
    reset();
    const out = await run();
    const inv = (id) => mem.db.invoices.filter((i) => i.business_id === id);
    assert.equal(inv(M).length, 1); assert.equal(inv(Y).length, 1);
    const im = inv(M)[0], iy = inv(Y)[0];
    assert.deepEqual([im.status, im.kind, im.amount, im.period_start], ['pending', 'cloud', 3000, biz(M).web_access_expires_at]);
    assert.equal(im.period_end, CP.addMonthsClamped(biz(M).web_access_expires_at, 1));
    assert.deepEqual([iy.amount, iy.period_end], [36000, CP.addMonthsClamped(biz(Y).web_access_expires_at, 12)]);
    assert.match(im.invoice_number, /^INV-\d{4}-\d{4}$/); assert.notEqual(im.invoice_number, iy.invoice_number);
    const owner = mails.find((m) => m.to === 'owner@pollo.test');
    assert.ok(owner, `mails to ${mails.map((m) => m.to).join(', ')}`);
    assert.match(owner.subject, new RegExp(`ZapTill invoice ${im.invoice_number}`));
    for (const re of [/KES 3,000/, /0717 675 635/, /M-Pesa/, /Due/, /Now/, new RegExp(EM.planDate(im.period_start))]) assert.match(owner.html, re);
    assert.match(owner.html, /Pollo &lt;b&gt;Grill&lt;\/b&gt;/, 'the name escaped');
    assert.ok(mails.find((m) => m.to === 'year@duka.test' && /KES 36,000/.test(m.html)), 'the 12-month client\'s invoice');
    assert.ok(out.sent.some((x) => x.business_id === M && x.milestone === 'invoice' && x.owner && x.admin));
  });
  await ok('the client\'s invoice email says nothing of a lock, a pause, a deadline or a revocation', async () => {
    const owner = mails.find((m) => m.to === 'owner@pollo.test');
    assert.doesNotMatch(owner.subject, NO_REVOKE);
    assert.doesNotMatch(stripTags(owner.html), NO_REVOKE);
    const pure = EM.invoiceWords({ businessName: 'Duka', invoiceNumber: 'INV-2026-0001', periodStart: '2026-11-23T07:00:00Z', periodEnd: '2026-12-23T07:00:00Z', amount: 3000, currency: 'KES', period: 'monthly' });
    for (const l of [pure.subject, pure.headline, ...pure.lines, ...pure.facts.flat()]) assert.doesNotMatch(l, NO_REVOKE, l);
  });
  await ok('ZapTill gets its copy (the admin email): the invoice, who it went to, when it locks', async () => {
    const admin = mails.find((m) => /billing@zaptill\.test/.test(m.to) && /Pollo/.test(m.subject) && /invoice/i.test(m.subject));
    assert.ok(admin, mails.map((m) => `${m.to}: ${m.subject}`).join(' | '));
    assert.match(admin.html, /owner@pollo\.test/); assert.match(admin.html, /locks at the end of/);
  });
  await ok('once per period: the next hour sends nothing; even with the claim lost, no second invoice for the period', async () => {
    mails.length = 0;
    assert.equal((await run()).sent.length, 0); assert.equal(mails.length, 0);
    mem.db.cloud_plan_reminders = mem.db.cloud_plan_reminders.filter((r) => !(r.business_id === M && r.milestone === 'invoice'));
    await run();
    assert.equal(mem.db.invoices.filter((i) => i.business_id === M).length, 1, 'still one invoice');
  });
  await ok('the next period (monthly: each month) is a new invoice once the payment moves the due date on', async () => {
    reset(); await run();
    const r = await pay(M, { amount: 3000, method: 'mpesa', reference: 'SJK1MONTH1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    CP.forgetStanding();   // paid for the month ahead
    assert.equal((await run()).sent.filter((x) => x.business_id === M).length, 0, 'not due yet: nothing');
    setPaidUntil(Date.now() - 3600_000);   // a month on: due again
    await run();
    assert.equal(mem.db.invoices.filter((i) => i.business_id === M).length, 2);
  });

  console.log('\n3. The bridge\n');
  await ok('a dated licence with no plan: put on the plan (12 months, KES 36,000, a note, audited) and invoiced from the bridge day', async () => {
    reset();
    const before = Date.now();
    const out = await run();
    assert.ok(out.bridged.includes(LG));
    const plan = mem.db.cloud_plans.find((p) => p.business_id === LG);
    assert.deepEqual([plan.period, plan.amount, plan.updated_by], ['12_months', 36000, 'A584 bridge']);
    assert.match(plan.notes, /check the period and amount/);
    assert.ok(Date.parse(plan.created_at) >= before - 1000);
    const a = mem.db.admin_audit_log.find((x) => x.action === 'cloud_plan.bridge' && x.business_id === LG);
    assert.ok(a); assert.equal(a.before_data.web_access_expires_at, biz(LG).web_access_expires_at);
    const inv = mem.db.invoices.find((i) => i.business_id === LG);
    assert.equal(inv.period_start, plan.created_at, 'the period starts the day it was bridged'); assert.equal(inv.amount, 36000);
    assert.ok(mails.find((m) => m.to === 'legacy@park.test'), 'the legacy client gets its invoice');
  });
  await ok('…and is never locked by the deploy: 20 days past its date (not yet locked by the old ladder — A587), its till syncs and its web works for the 7 days', async () => {
    CP.forgetStanding();
    assert.equal((await call('POST', '/api/sync/push', TILL_LG, {})).status, 200);
    assert.equal((await call('GET', '/api/reports/daily', web(LG))).status, 200);
    const w = await W.getWebAccess(LG, 'active'); assert.equal(w.canLogin, true); assert.equal(w.fullAccess, true);
  });
  await ok('web access on with no expiry: unchanged (no plan made, no invoice, never locked) and listed "No expiry set"', async () => {
    assert.equal(mem.db.cloud_plans.some((p) => p.business_id === NE), false);
    assert.equal(mem.db.invoices.some((i) => i.business_id === NE), false);
    assert.equal((await W.getWebAccess(NE, 'active')).state, 'active');
    const list = await call('GET', '/api/admin/clients?expiry=no_expiry', ADMIN);
    assert.deepEqual(list.body.clients.map((c) => c.id), [NE]);
    assert.equal(P.expiryText(list.body.clients[0].cloud).text, 'No expiry set');
  });
  await ok('switched off with a date and no plan: not bridged, not invoiced', async () => {
    assert.equal(mem.db.cloud_plans.some((p) => p.business_id === OFF), false);
    assert.equal(mem.db.invoices.some((i) => i.business_id === OFF), false);
  });

  console.log('\n4. ZapTill only\n');
  await ok('day 5 unpaid: ZapTill hears "locks in 2 days" — the client hears nothing', async () => {
    // a fixed moment: noon Nairobi today, the due date exactly 5 days before it (no edge at midnight)
    const noon = BC.nairobiDayStart(Date.now()) + 12 * 3600_000;
    reset(); setPaidUntil(noon - 5 * DAY);
    mem.db.businesses = mem.db.businesses.filter((b) => b.id === M);
    await run(new Date(noon));   // the invoice (missed day 0) and the day-5 note
    const s = CP.cloudStanding((await CP.readCloudFacts([M])).get(M), noon);
    assert.deepEqual([s.unpaidDays, s.lockInDays], [5, 2]);
    const ms = mem.db.cloud_plan_reminders.filter((r) => r.business_id === M).map((r) => r.milestone).sort();
    assert.deepEqual(ms, ['invoice', 'unpaid_5']);
    assert.deepEqual(CP.adminMilestones(CP.cloudStanding((await CP.readCloudFacts([M])).get(M), noon - DAY), noon - DAY), ['invoice'], 'day 4: no note yet');
    const note = mails.find((m) => /unpaid/.test(m.subject));
    assert.ok(note && /billing@zaptill\.test/.test(note.to), mails.map((m) => `${m.to}: ${m.subject}`).join(' | '));
    assert.match(note.subject, /locks in 2 days/);
    assert.equal(mails.filter((m) => m.to === 'owner@pollo.test').length, 1, 'the owner: the invoice only');
    assert.doesNotMatch(mails.find((m) => m.to === 'owner@pollo.test').html.replace(/<[^>]+>/g, ' '), NO_REVOKE);
  });
  await ok('the lock: ZapTill once (never the client), then the morning digest lists it every day', async () => {
    mails.length = 0; setPaidUntil(Date.now() - 10 * DAY);
    await run();
    const locked = mails.filter((m) => /locked/.test(m.subject));
    assert.equal(locked.length, 1); assert.match(locked[0].to, /billing@zaptill\.test/);
    assert.equal(mails.filter((m) => m.to === 'owner@pollo.test').length, 0, 'nothing to the owner: no lock notice (and no invoice once locked — A587: pay as you go)');
    mails.length = 0; await run();
    assert.equal(mails.filter((m) => /locked/.test(m.subject)).length, 0, 'once');
    const lines = await CP.billingDigestLines();
    assert.ok(lines.some((l) => /Cloud locked \(1\)/.test(l)) && lines.some((l) => /Pollo/.test(l)), lines.join(' | '));
    assert.match(read('apps/server/src/jobs/watchdog.ts'), /billingDigestLines\(now\.getTime\(\)\)/);
  });
  await ok('A581\'s client reminders are gone (no 14 / 7 / 3 / 1 days, no lapse-day or weekly emails)', () => {
    assert.equal(CP.reminderMilestone, undefined); assert.equal(EM.reminderEmailHtml, undefined);
    assert.deepEqual(CP.adminMilestones(CP.cloudStanding({ onPlan: true, planCreatedAt: LONG_AGO, trial: null, expiresAt: iso(Date.now() + 3 * DAY), webHosting: true }), Date.now()), []);
  });

  console.log('\n5. The lock over HTTP, and the payment that restores it\n');
  await ok('locked: every web request paused (403 CLOUD_ACCESS_PAUSED — reads too, the plain words); /api/auth open', async () => {
    reset(); setPaidUntil(Date.now() - 9 * DAY);
    const r = await call('GET', '/api/reports/daily', OWNER_WEB);
    assert.equal(r.status, 403); assert.equal(r.body.code, 'CLOUD_ACCESS_PAUSED');
    assert.equal(r.body.error, 'Your ZapTill cloud access is paused. Call 0717 675 635 to renew.');
    assert.equal((await call('POST', '/api/expenses', OWNER_WEB, {})).status, 403);
    assert.equal((await call('POST', '/api/auth/logout-standin', OWNER_WEB, {})).status, 200, 'sign-in housekeeping still goes');
    const w = await W.getWebAccess(M, 'active');
    assert.equal(w.canLogin, false); assert.equal(W.webAccessRefusal(w).code, 'CLOUD_ACCESS_PAUSED');
  });
  await ok('locked: the tills keep their sales (503, queued) and no till joins', async () => {
    const s = await call('POST', '/api/sync/push', TILL_M, {});
    assert.equal(s.status, 503); assert.equal(s.body.code, 'CLOUD_SUBSCRIPTION_ENDED');
    const e = await call('POST', '/api/auth/enrol/redeem', null, { business_id: M, code: CODE, device_id: 'new-till' });
    assert.equal(e.body?.code, 'CLOUD_SUBSCRIPTION_ENDED'); assert.equal(mem.db.device_enrolment_codes[0].status, 'active');
  });
  await ok('a payment restores everything at once (web, sync, enrolment) — a locked client starts from today (A587: pay as you go); a receipt', async () => {
    const r = await pay(M, { amount: 3000, method: 'mpesa', reference: 'SJK8LOCK01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(Math.abs(Date.parse(biz(M).web_access_expires_at) - Date.parse(CP.addMonthsClamped(iso(Date.now()), 1))) < 120_000);
    assert.equal((await call('GET', '/api/reports/daily', OWNER_WEB)).status, 200);
    assert.equal((await call('POST', '/api/sync/push', TILL_M, {})).status, 200);
    assert.notEqual((await call('POST', '/api/auth/enrol/redeem', null, { business_id: M, code: CODE, device_id: 'new-till' })).body?.code, 'CLOUD_SUBSCRIPTION_ENDED');
    const receipt = mails.find((m) => m.to === 'owner@pollo.test' && /receipt/i.test(m.subject));
    assert.ok(receipt); assert.match(receipt.html, /KES 3,000/); assert.match(receipt.html, /SJK8LOCK01/); assert.equal(r.body.receipt_sent, true);
  });
  await ok('within the 7 days: the payment covers the invoiced period (from the due date) and marks its invoice paid — no second invoice', async () => {
    reset(); setPaidUntil(Date.now() - 3 * DAY);
    mem.db.businesses = mem.db.businesses.filter((b) => b.id === M);
    await run();
    const due = biz(M).web_access_expires_at;
    const inv = mem.db.invoices.find((i) => i.business_id === M);
    assert.equal(inv.status, 'pending');
    const r = await pay(M, { amount: 3000, method: 'mpesa', reference: 'SJK9WEEK01' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(biz(M).web_access_expires_at, CP.addMonthsClamped(due, 1), 'paid until one month after the due date');
    assert.equal(mem.db.invoices.filter((i) => i.business_id === M).length, 1);
    assert.deepEqual([inv.status, inv.payment_reference], ['paid', 'SJK9WEEK01']);
    assert.equal(mem.db.cloud_payments[0].invoice_id, inv.id);
    assert.equal(r.body.invoice_number, inv.invoice_number);
    const a = mem.db.admin_audit_log.find((x) => x.action === 'cloud_plan.payment');
    assert.equal(a.before_data.state, 'unpaid');
  });
  await ok('the M-Pesa code stays once only; super admins only record payments', async () => {
    assert.equal((await pay(M, { amount: 3000, reference: 'SJK9WEEK01' })).body.code, 'DUPLICATE_REFERENCE');
    assert.equal((await pay(M, { amount: 3000, reference: 'SJKAGENT01' }, AGENT_T)).status, 403);
  });

  console.log('\n6. "Enable web access" retired; the complimentary paid-until\n');
  await ok('a bare "Enable web access" is refused (409 WEB_ACCESS_BY_PLAN) and raises no invoice; the portal no longer offers KES 10,000', async () => {
    reset();
    const r = await call('PATCH', `/api/admin/clients/${OFF}/features/web_hosting`, ADMIN, { enabled: true });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'WEB_ACCESS_BY_PLAN');
    assert.equal(mem.db.feature_flags.find((f) => f.business_id === OFF).enabled, false); assert.equal(mem.db.invoices.length, 0);
    setPaidUntil(Date.now() + 20 * DAY, OFF);
    assert.equal((await call('PATCH', `/api/admin/clients/${OFF}/features/web_hosting`, ADMIN, { enabled: true })).status, 200, 'paid-until still ahead: switched back on');
    const a = read('apps/admin/src/AdminPortal.tsx');
    const code = a.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join('\n');   // the comments may name the old price
    assert.doesNotMatch(code, /amount:\s*10000/); assert.doesNotMatch(code, /Web Portal Hosting — Annual Access/); assert.doesNotMatch(code, /KES 10,000/);
    assert.doesNotMatch(read('apps/dashboard/src/pages/LoginPage.tsx'), /KES 10,000/);
  });
  await ok('the complimentary paid-until: super admin, a reason required, web on, put on the plan, audited, no invoice', async () => {
    const until = iso(Date.now() + 90 * DAY);
    assert.equal((await call('POST', `/api/admin/clients/${NE}/cloud-plan/complimentary`, AGENT_T, { paid_until: until, reason: 'launch partner' })).status, 403);
    const no = await call('POST', `/api/admin/clients/${NE}/cloud-plan/complimentary`, ADMIN, { paid_until: until, reason: '' });
    assert.equal(no.status, 400); assert.equal(no.body.code, 'REASON_REQUIRED');
    assert.equal((await call('POST', `/api/admin/clients/${NE}/cloud-plan/complimentary`, ADMIN, { paid_until: iso(Date.now() - DAY), reason: 'x y z' })).status, 400);
    const r = await call('POST', `/api/admin/clients/${NE}/cloud-plan/complimentary`, ADMIN, { paid_until: until, reason: 'launch partner' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(biz(NE).web_access_expires_at, until);
    assert.ok(mem.db.cloud_plans.find((p) => p.business_id === NE));
    const a = mem.db.admin_audit_log.find((x) => x.action === 'cloud_plan.complimentary');
    assert.deepEqual([a.reason, a.after_data.paid_until, a.before_data.paid_until], ['launch partner', until, null]);
    assert.equal(mem.db.invoices.filter((i) => i.business_id === NE).length, 0);
    assert.equal(r.body.standing.state, 'active');
  });

  console.log('\n7. Shown\n');
  await ok('the dashboard: the paused screen and the sign-in card read the plain words; no paid-plan notice anywhere', () => {
    const pw = PZ.pausedWords('CLOUD_ACCESS_PAUSED');
    assert.equal(`${pw.title}. ${pw.body}`, 'Your ZapTill cloud access is paused. Call 0717 675 635 to renew.');
    assert.equal(PZ.PAUSED_SENTENCE, 'Your ZapTill cloud access is paused. Call 0717 675 635 to renew.');
    assert.doesNotMatch(`${pw.title} ${pw.body}`, /unpaid|owe|late|fail|because/i, 'no blame');
    assert.match(PZ.pausedWords('CLOUD_TRIAL_ENDED').title, /trial has ended/);
    assert.equal(N.planNotice, undefined);
    const api = read('apps/dashboard/src/lib/api.ts');
    assert.match(api, /res\.status === 403 && \(json\?\.code === 'CLOUD_ACCESS_PAUSED' \|\| json\?\.code === 'CLOUD_TRIAL_ENDED'\)/);
    assert.match(read('apps/dashboard/src/App.tsx'), /<CloudPausedScreen \/>/);
    const login = read('apps/dashboard/src/pages/LoginPage.tsx');
    assert.match(login, /CLOUD_ACCESS_PAUSED: \{[\s\S]*?PAUSED_BODY/);
    assert.doesNotMatch(read('apps/dashboard/src/components/CloudTrialNotice.tsx'), /planNotice/);
  });
  await ok('GET /api/business/cloud-trial carries no plan for the owner\'s dashboard (plan: null)', async () => {
    reset(); setPaidUntil(Date.now() + 3 * DAY);
    const r = await call('GET', '/api/business/cloud-trial', OWNER_WEB);
    assert.equal(r.status, 200); assert.equal(r.body.plan, null);
  });
  await ok('the admin list: "Due in 3 days" / "Unpaid 3 days (locks in 4 days)" / "Locked 2 days" / "No expiry set"; filters', async () => {
    const st = (x) => P.expiryText(x)?.text;
    const all = await call('GET', '/api/admin/clients', ADMIN);
    assert.equal(st(all.body.clients.find((c) => c.id === M).cloud), 'Due in 3 days');
    assert.equal(st({ state: 'unpaid', unpaid_days: 3, lock_in_days: 4, days_left: -3, paid_until: 'x' }), 'Unpaid 3 days (locks in 4 days)');
    assert.equal(st({ state: 'unpaid', unpaid_days: 7, lock_in_days: 0, days_left: -7, paid_until: 'x' }), 'Unpaid 7 days (locks tonight)');
    assert.equal(st({ state: 'unpaid', unpaid_days: 0, lock_in_days: 7, days_left: 0, paid_until: 'x' }), 'Due today (locks in 7 days)');
    assert.equal(st({ state: 'locked', locked_days: 2, sync_refused: true, paid_until: 'x' }), 'Locked 2 days');
    assert.equal(st({ state: 'no_expiry' }), 'No expiry set');
    setPaidUntil(Date.now() - 3 * DAY, Y);
    assert.deepEqual((await call('GET', '/api/admin/clients?expiry=unpaid', ADMIN)).body.clients.map((c) => c.id).sort(), [Y, LG].sort());
    setPaidUntil(Date.now() - 12 * DAY, Y);
    assert.deepEqual((await call('GET', '/api/admin/clients?expiry=locked', ADMIN)).body.clients.map((c) => c.id), [Y]);
    assert.deepEqual((await call('GET', '/api/admin/clients?expiry=due', ADMIN)).body.clients.map((c) => c.id), [M]);
    const a = read('apps/admin/src/AdminPortal.tsx');
    for (const v of ['due', 'unpaid', 'locked', 'no_expiry']) assert.match(a, new RegExp(`<option value="${v}">`));
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
