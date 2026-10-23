/**
 * cloud-plan-a581.test.mjs — A581: the cloud payment plan per business — period maths, Record payment, the lapse (the
 * cloud stops syncing, no till joins), resume after payment, and the reminders to the owner AND ZapTill.
 *
 * Owner, 2026-10-23: "if a client stops paying for the cloud … yes till continues to work, but the cloud stops syncing and
 * the till cannot be re-registered until the client pays again. add payment plan option such that i can select month on
 * month and always remind me on email about expiry and also the client".
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/cloud-plan-a581.test.mjs
 *
 * RUNS the COMPILED server — the real auth middleware (the lapse gate), the admin, cloud-plan admin, auth (enrolment) and
 * business routers over HTTP on the in-memory database (tests/lib-memdb.mjs), the reminders job, lib/cloudPlan.js and
 * lib/cloudPlanEmail.js — and the dashboard's notice and the admin portal's words from their TypeScript:
 *   1 the rules: month maths (31 Jan → 28/29 Feb, 31 Mar → 30 Apr), one period from the LATER of now and paid-until,
 *     custom end dates, the default amounts (KES 3,000 a month, no discount), the standing (not on the plan; a paid
 *     client's 21-day grace; a trial's none), the milestones, which till writes the gate covers
 *   2 the lapse over HTTP: a lapsed business's till write → 503 CLOUD_SUBSCRIPTION_ENDED (its reads, a web write, another
 *     business and a client in grace untouched; a business not on the plan never gated); enrolment refused before the
 *     code is spent; the admin's enrolment code refused; not a server error for the watchdog
 *   3 Record payment: paid-until from today when lapsed, from paid-until when early (no lost days), invoice (paid),
 *     web access on, audited who / amount / M-Pesa code; sync resumes at once; the code redeems; a trial converts;
 *     a code twice is refused; an agent cannot record; the plan is editable
 *   4 the reminders: owner AND ZapTill, once per milestone (idempotent), a new paid-until afresh, weekly while lapsed,
 *     no provider → logged and skipped (no crash), the words (amount, period, date, how to pay, escaped name)
 *   5 shown: the owner's dashboard notice (last 14 days, lapsed), the admin client list's "Expires in / Lapsed" and its
 *     filter; no cashier surface (the till's notice is the manager's — apps/desktop/test/cloud-lapsed-a581.test.mjs)
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A581 report):
 *   - addMonthsClamped without the month-end clamp                         → 1 "31 Jan → 28 Feb" fails
 *   - nextPaidUntil from now always (not the later of now and paid-until)  → 1 "no lost days", 3 "early payment" fail
 *   - cloudStanding refusing in the grace (state !== 'active')             → 1 "21-day grace", 2 "in grace" fail
 *   - the middleware without cloudLapseBlocked                             → 2 "503 CLOUD_SUBSCRIPTION_ENDED" fails
 *   - the enrolment check after the burn instead of before                 → 2 "code not spent" fails
 *   - the reminder claim check removed (cloudPlanReminders seen)             → 4 "idempotent" fails
 *   - forgetStanding removed from Record payment                           → 3 "sync resumes at once" fails
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
if (!fs.existsSync(path.join(DIST, 'lib/cloudPlan.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
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
supabase.auth.admin.getUserById = async (uid) => ({ data: { user: { id: uid, email: uid === OWNER ? 'owner@pollo.test' : null } }, error: null });
const mailer = require(path.join(DIST, 'lib/mailer.js'));
const mails = [];
let mailOk = true;
mailer.sendEmailChecked = async (m) => { mails.push(m); return mailOk ? { ok: true, provider: 'test' } : { ok: false, provider: 'none', error: 'No email provider configured' }; };
const adminAuth = require(path.join(DIST, 'middleware/adminAuth.js'));
const { requireAuth } = require(path.join(DIST, 'middleware/auth.js'));
const CP = require(path.join(DIST, 'lib/cloudPlan.js'));
const EM = require(path.join(DIST, 'lib/cloudPlanEmail.js'));
const JOB = require(path.join(DIST, 'jobs/cloudPlanReminders.js'));
const N = await import(pathToFileURL(path.join(ROOT, 'apps/dashboard/src/lib/cloudTrialNotice.ts')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'apps/admin/src/cloudPlan.ts')).href);

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const SUPER = 'aaaaaaaa-0000-4000-8000-0000000000a1', AGENT = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const B = '11111111-1111-4111-8111-111111111111';    // on the plan (Pollo)
const L = '11111111-1111-4111-8111-111111111112';    // legacy: never on the plan, an old expiry
const T = '11111111-1111-4111-8111-111111111113';    // a cloud trial
const BR = '22222222-2222-4222-8222-222222222221', LR = '22222222-2222-4222-8222-222222222222', TR = '22222222-2222-4222-8222-222222222223';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const CODE = 'ABCD-EFGH';
const hash = (c) => crypto.createHash('sha256').update(c).digest('hex');
const biz = (id = B) => mem.db.businesses.find((b) => b.id === id);
const setPaidUntil = (ms, id = B) => { biz(id).web_access_expires_at = ms === null ? null : iso(ms); CP.forgetStanding(); };
const reset = () => {
  mem.fail = () => null; mem.calls = []; mails.length = 0; mailOk = true;
  const now = Date.now();
  mem.db = {
    admin_users: [
      { id: SUPER, email: 'boss@zaptill.test', name: 'Boss', role: 'super_admin', is_active: true },
      { id: AGENT, email: 'agent@zaptill.test', name: 'Agent', role: 'agent', is_active: true },
    ],
    businesses: [
      { id: B, name: 'Pollo <b>Grill</b>', owner_id: OWNER, email: 'shop@pollo.test', status: 'active', type: 'restaurant', currency: 'KES', web_access_expires_at: iso(now - 30 * DAY), created_at: '2026-09-01T00:00:00Z' },
      { id: L, name: 'Legacy Duka', owner_id: 'x', email: null, status: 'active', type: 'retail', currency: 'KES', web_access_expires_at: iso(now - 90 * DAY), created_at: '2026-08-01T00:00:00Z' },
      { id: T, name: 'Trial Parking', owner_id: 'y', email: 'trial@park.test', status: 'active', type: 'parking', currency: 'KES', web_access_expires_at: iso(now - 2 * DAY), created_at: '2026-09-10T00:00:00Z' },
    ],
    branches: [
      { id: BR, business_id: B, name: 'Main', is_main: true, status: 'active', desktop_licensed: true },
      { id: LR, business_id: L, name: 'Main', is_main: true, status: 'active', desktop_licensed: true },
      { id: TR, business_id: T, name: 'Main', is_main: true, status: 'active', desktop_licensed: true },
    ],
    cloud_plans: [{ business_id: B, period: 'monthly', amount: 3000, currency: 'KES', custom_until: null, notes: null, updated_by: 'boss@zaptill.test' }],
    business_settings: [{ business_id: T, key: 'cloud_trial', value: { started_at: iso(now - 32 * DAY), ends_at: iso(now - 2 * DAY), branch_id: TR, started_by: SUPER, converted_at: null } }],
    feature_flags: [{ business_id: B, key: 'web_hosting', enabled: true }, { business_id: T, key: 'web_hosting', enabled: true }],
    user_devices: [
      { id: 'ud1', business_id: B, device_id: 'till-B', status: 'approved', retired_at: null, branch_id: BR },
      { id: 'ud2', business_id: L, device_id: 'till-L', status: 'approved', retired_at: null, branch_id: LR },
      { id: 'ud3', business_id: T, device_id: 'till-T', status: 'approved', retired_at: null, branch_id: TR },
    ],
    device_enrolment_codes: [{ id: 'ec1', business_id: B, branch_id: BR, code_hash: hash(CODE), status: 'active', expires_at: iso(now + 600_000) }],
    cloud_payments: [], cloud_plan_reminders: [], invoices: [], admin_audit_log: [], subscriptions: [], plans: [],
    users: [{ id: OWNER, business_id: B, name: 'Owner', status: 'active', permissions_version: 0 }],
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
// Stand-ins for a till's writes and reads, behind the REAL requireAuth (where the lapse gate lives).
let lapsedFlag = null;
app.post('/api/sync/push', requireAuth, (_req, res) => { lapsedFlag = res.locals.cloudLapsed ?? null; res.json({ ok: true, upserted: {}, rejected: [] }); });
app.post('/api/orders', requireAuth, (_req, res) => res.status(201).json({ orderId: 'o1' }));
app.post('/api/support/logs', requireAuth, (_req, res) => res.json({ ok: true }));
app.get('/api/pos/catalogue-version', requireAuth, (_req, res) => res.json({ version: 'v1' }));
app.post('/api/expenses', requireAuth, (_req, res) => res.status(201).json({ ok: true }));
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), retry: r.headers.get('retry-after') };
};
const ADMIN = jwt.sign({ adminId: SUPER, email: 'boss@zaptill.test', role: 'super_admin' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const AGENT_T = jwt.sign({ adminId: AGENT, email: 'agent@zaptill.test', role: 'agent' }, process.env.ADMIN_JWT_SECRET, { algorithm: 'HS256' });
const till = (businessId, deviceId, branchId) => jwt.sign({ userId: null, deviceId, till: true, businessId, branchId, isOwner: false,
  permissionKeys: ['*'], permissionsVersion: 0, sessionId: 's', surface: 'desktop' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const TILL_B = till(B, 'till-B', BR), TILL_L = till(L, 'till-L', LR), TILL_T = till(T, 'till-T', TR);
const OWNER_WEB = jwt.sign({ userId: OWNER, businessId: B, branchId: null, isOwner: true, surface: 'dashboard', permissionKeys: ['*'],
  permissionsVersion: 0, sessionId: 's' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const pay = (id, body, token = ADMIN) => call('POST', `/api/admin/clients/${id}/cloud-plan/payments`, token, body);

try {
  console.log('\n1. The rules\n');
  await ok('month maths in Nairobi\'s calendar: 31 Jan → 28 Feb (29 in 2028), 31 Mar → 30 Apr, 30 Nov + 3 → 28 Feb, 15 Oct + 12 → 15 Oct', () => {
    // 10:00 EAT = 07:00 UTC
    assert.equal(CP.addMonthsClamped('2027-01-31T07:00:00.000Z', 1), '2027-02-28T07:00:00.000Z');
    assert.equal(CP.addMonthsClamped('2028-01-31T07:00:00.000Z', 1), '2028-02-29T07:00:00.000Z');
    assert.equal(CP.addMonthsClamped('2027-03-31T07:00:00.000Z', 1), '2027-04-30T07:00:00.000Z');
    assert.equal(CP.addMonthsClamped('2026-11-30T07:00:00.000Z', 3), '2027-02-28T07:00:00.000Z');
    assert.equal(CP.addMonthsClamped('2026-10-15T07:00:00.000Z', 12), '2027-10-15T07:00:00.000Z');
    // 31 Jan 23:30 EAT is 31 Jan 20:30 UTC — the Nairobi day decides, not the UTC one
    assert.equal(CP.addMonthsClamped('2027-01-31T20:30:00.000Z', 1), '2027-02-28T20:30:00.000Z');
    // 1 Feb 01:00 EAT is 31 Jan 22:00 UTC — a UTC calendar would clamp it to 28 Feb; Nairobi's says 1 Mar
    assert.equal(CP.addMonthsClamped('2027-01-31T22:00:00.000Z', 1), '2027-02-28T22:00:00.000Z');
  });
  await ok('no lost days: one period from the LATER of now and paid-until (early → added on; lapsed → from today)', () => {
    const now = Date.parse('2026-10-23T07:00:00Z');
    const early = CP.nextPaidUntil({ period: 'monthly', now, paidUntil: '2026-11-02T07:00:00.000Z' });
    assert.deepEqual([early.from, early.until], ['2026-11-02T07:00:00.000Z', '2026-12-02T07:00:00.000Z']);
    const late = CP.nextPaidUntil({ period: '3_months', now, paidUntil: '2026-09-01T07:00:00.000Z' });
    assert.deepEqual([late.from, late.until], ['2026-10-23T07:00:00.000Z', '2027-01-23T07:00:00.000Z']);
    assert.equal(CP.nextPaidUntil({ period: '6_months', now, paidUntil: null }).until, '2027-04-23T07:00:00.000Z');
    assert.equal(CP.nextPaidUntil({ period: '12_months', now, paidUntil: null }).until, '2027-10-23T07:00:00.000Z');
  });
  await ok('a custom period runs to the date given, which must be after what is already paid', () => {
    const now = Date.parse('2026-10-23T07:00:00Z');
    assert.equal(CP.nextPaidUntil({ period: 'custom', now, paidUntil: null, customUntil: '2027-03-01T20:59:00.000Z' }).until, '2027-03-01T20:59:00.000Z');
    assert.equal(CP.nextPaidUntil({ period: 'custom', now, paidUntil: '2026-12-01T00:00:00Z', customUntil: '2026-11-15T00:00:00Z' }).code, 'CUSTOM_END_TOO_EARLY');
    assert.equal(CP.nextPaidUntil({ period: 'custom', now, paidUntil: null }).code, 'CUSTOM_END_REQUIRED');
  });
  await ok('the default amounts: KES 3,000 a month, no discount for paying ahead; custom is typed', () => {
    assert.deepEqual(['monthly', '3_months', '6_months', '12_months'].map((p) => CP.defaultAmount(p)), [3000, 9000, 18000, 36000]);
    assert.equal(CP.defaultAmount('custom'), null);
    assert.equal(P.periodDefault('6_months'), '18000');
  });
  await ok('the standing: not on the plan → never gated; a paid client keeps the 21-day grace; a trial has none', () => {
    const now = Date.now();
    const f = (x) => ({ onPlan: true, trial: null, expiresAt: iso(now - 10 * DAY), webHosting: true, ...x });
    assert.equal(CP.cloudStanding({ ...f(), onPlan: false, expiresAt: iso(now - 400 * DAY) }, now).syncRefused, false);
    assert.equal(CP.cloudStanding({ ...f(), onPlan: false }, now).state, 'not_on_plan');
    const g = CP.cloudStanding(f(), now);
    assert.equal(g.state, 'grace'); assert.equal(g.syncRefused, false); assert.equal(g.daysLeft, -10);
    assert.equal(Date.parse(g.syncStopsAt) - Date.parse(g.paidUntil), 21 * DAY);
    assert.equal(CP.cloudStanding(f({ expiresAt: iso(now - 22 * DAY) }), now).syncRefused, true);
    assert.equal(CP.cloudStanding(f({ expiresAt: iso(now - 40 * DAY) }), now).state, 'locked');
    const trial = { started_at: iso(now - 31 * DAY), ends_at: iso(now - DAY), branch_id: null, started_by: null, converted_at: null };
    const t = CP.cloudStanding({ onPlan: false, trial, expiresAt: trial.ends_at, webHosting: true }, now);
    assert.equal(t.gated, true); assert.equal(t.trial, true); assert.equal(t.syncRefused, true, 'no grace for a trial');
    assert.equal(CP.cloudStanding({ onPlan: false, trial, expiresAt: iso(now + 5 * DAY), webHosting: false }, now).state, 'ended', '"End trial" is over at once');
    assert.equal(CP.cloudStanding(f({ expiresAt: null }), now).state, 'no_date');
  });
  await ok('the milestones: 14 / 7 / 3 / 1 day(s) before, the lapse day, every 7 days lapsed (8 at most)', () => {
    const m = (d) => CP.reminderMilestone(d);
    assert.deepEqual([20, 15, 14, 8, 7, 4, 3, 2, 1, 0, -1, -6, -7, -13, -14, -56, -62, -63].map(m),
      [null, null, 'before_14', 'before_14', 'before_7', 'before_7', 'before_3', 'before_3', 'before_1', 'lapse_day', 'lapse_day', 'lapse_day',
        'lapsed_w1', 'lapsed_w1', 'lapsed_w2', 'lapsed_w8', 'lapsed_w8', null]);
  });
  await ok('the gate covers a till\'s writes — never its sign-in / renewals, the technician, support logs, a read, a web write', () => {
    const g = CP.lapseGateApplies;
    for (const p of ['/api/orders', '/api/sync/push', '/api/changes', '/api/shifts/x/close', '/api/pos/join-code', '/api/products']) assert.equal(g('desktop', 'POST', p), true, p);
    for (const p of ['/api/auth/refresh', '/api/auth/device-token', '/api/tech/audit', '/api/support/logs', '/api/desktop-update/state']) assert.equal(g('desktop', 'POST', p), false, p);
    assert.equal(g('desktop', 'GET', '/api/pos/init'), false);
    assert.equal(g('dashboard', 'POST', '/api/orders'), false);
    assert.equal(g('web', 'POST', '/api/orders'), false);
  });

  console.log('\n2. The lapse over HTTP\n');
  await ok('a lapsed business\'s till write → 503 CLOUD_SUBSCRIPTION_ENDED (plain words, Retry-After); its reads and support logs still go', async () => {
    reset();
    const r = await call('POST', '/api/sync/push', TILL_B, {});
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'CLOUD_SUBSCRIPTION_ENDED');
    assert.match(r.body.error, /keeps selling/); assert.match(r.body.error, /0717 675 635/);
    assert.equal(r.retry, '900');
    assert.equal((await call('POST', '/api/orders', TILL_B, {})).status, 503);
    assert.equal((await call('GET', '/api/pos/catalogue-version', TILL_B)).status, 200);
    assert.equal((await call('POST', '/api/support/logs', TILL_B, {})).status, 200);
  });
  await ok('a web write of the same business is not this gate\'s (the dashboard ladder decides); another business untouched', async () => {
    assert.equal((await call('POST', '/api/expenses', OWNER_WEB, {})).status, 201);
    assert.equal((await call('POST', '/api/sync/push', TILL_L, {})).status, 200, 'a business not on the plan is never gated (legacy, 90 days past)');
  });
  await ok('in grace (10 days past paid-until): sync goes on', async () => {
    setPaidUntil(Date.now() - 10 * DAY);
    assert.equal((await call('POST', '/api/sync/push', TILL_B, {})).status, 200);
    setPaidUntil(Date.now() - 30 * DAY);
  });
  await ok('a lapsed trial (2 days after its end, no grace) → refused too, with the trial\'s words', async () => {
    const r = await call('POST', '/api/orders', TILL_T, {});
    assert.equal(r.status, 503); assert.equal(r.body.trial, true); assert.match(r.body.error, /trial has ended/);
  });
  await ok('the refusal is not a server error for the watchdog (res.locals.cloudLapsed; index.ts skips it)', () => {
    assert.match(read('apps/server/src/middleware/auth.ts'), /res\.locals\.cloudLapsed = true/);
    assert.match(read('apps/server/src/index.ts'), /if \(res\.locals\.cloudLapsed === true\) return;\n\s+if \(res\.statusCode >= 500\) recordServerError/);
  });
  await ok('a till cannot join (enrolment code redeem) — refused BEFORE the code is spent, words for the technician', async () => {
    const r = await call('POST', '/api/auth/enrol/redeem', null, { business_id: B, code: CODE, device_id: 'new-till' });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'CLOUD_SUBSCRIPTION_ENDED');
    assert.match(r.body.error, /cannot be joined \(or rejoined\)/);
    assert.equal(mem.db.device_enrolment_codes[0].status, 'active', 'the code is not spent');
    const rj = await call('POST', '/api/auth/enrol/redeem', null, { business_id: B, code: CODE, device_id: 'till-B', rejoin: true, branch_id: BR });
    assert.equal(rj.body?.code, 'CLOUD_SUBSCRIPTION_ENDED', 'a rejoin too');
  });
  await ok('the admin\'s "Enrolment code" is refused for a lapsed client (record the payment first)', async () => {
    const r = await call('POST', `/api/admin/clients/${B}/branches/${BR}/enrol-code`, ADMIN, {});
    assert.equal(r.status, 409); assert.equal(r.body.code, 'CLOUD_SUBSCRIPTION_ENDED'); assert.match(r.body.error, /Record the payment/);
  });

  console.log('\n3. Record payment\n');
  await ok('an agent cannot record a payment or change the plan (super admin only)', async () => {
    assert.equal((await pay(B, { amount: 3000, reference: 'SJK4H7Q2LM' }, AGENT_T)).status, 403);
    assert.equal((await call('PUT', `/api/admin/clients/${B}/cloud-plan`, AGENT_T, { period: 'monthly', amount: 3000 })).status, 403);
    assert.equal((await call('GET', `/api/admin/clients/${B}/cloud-plan`, AGENT_T)).status, 200, 'an agent may look');
  });
  await ok('an M-Pesa payment needs its code', async () => {
    const r = await pay(B, { amount: 3000, method: 'mpesa', reference: '' });
    assert.equal(r.status, 400); assert.equal(r.body.code, 'BAD_REFERENCE');
  });
  let before;
  await ok('lapsed: paid-until runs one month from TODAY; a paid invoice; web access on; audited who / amount / code', async () => {
    before = biz().web_access_expires_at;
    const r = await pay(B, { amount: 3000, method: 'mpesa', reference: 'sjk4h7q2lm', note: 'paid on WhatsApp' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const until = Date.parse(biz().web_access_expires_at);
    assert.ok(Math.abs(until - Date.parse(CP.addMonthsClamped(iso(Date.now()), 1))) < 120_000, 'a month from now');
    const p = mem.db.cloud_payments[0];
    assert.equal(p.reference, 'SJK4H7Q2LM'); assert.equal(p.recorded_by, SUPER); assert.equal(p.recorded_by_email, 'boss@zaptill.test');
    assert.equal(p.paid_until_before, before); assert.equal(p.amount, 3000);
    const inv = mem.db.invoices[0];
    assert.equal(inv.status, 'paid'); assert.equal(inv.amount, 3000); assert.equal(inv.payment_reference, 'SJK4H7Q2LM'); assert.equal(p.invoice_id, inv.id);
    assert.equal(mem.db.feature_flags.find((f) => f.business_id === B && f.key === 'web_hosting').enabled, true);
    const a = mem.db.admin_audit_log.find((x) => x.action === 'cloud_plan.payment');
    assert.ok(a, 'audited'); assert.equal(a.admin_email, 'boss@zaptill.test');
    assert.deepEqual([a.after_data.amount, a.after_data.reference, a.before_data.paid_until], [3000, 'SJK4H7Q2LM', before]);
    assert.equal(r.body.standing.sync_refused, false);
  });
  await ok('sync resumes at once (the gate reads afresh) — the queued sale goes', async () => {
    assert.equal((await call('POST', '/api/orders', TILL_B, {})).status, 201);
    assert.equal((await call('POST', '/api/sync/push', TILL_B, {})).status, 200);
  });
  await ok('the same enrolment code now gets past the gate (it is spent by the join)', async () => {
    const r = await call('POST', '/api/auth/enrol/redeem', null, { business_id: B, code: CODE, device_id: 'new-till' });
    assert.notEqual(r.body?.code, 'CLOUD_SUBSCRIPTION_ENDED');
    assert.equal(mem.db.device_enrolment_codes[0].status, 'redeemed');
  });
  await ok('the same M-Pesa code twice is refused (409 DUPLICATE_REFERENCE) and nothing moves', async () => {
    const was = biz().web_access_expires_at;
    const r = await pay(B, { amount: 3000, reference: 'SJK4H7Q2LM' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'DUPLICATE_REFERENCE');
    assert.equal(biz().web_access_expires_at, was); assert.equal(mem.db.cloud_payments.length, 1);
  });
  await ok('paid early: the next period is added to what is left (no lost days)', async () => {
    const was = biz().web_access_expires_at;
    const r = await pay(B, { amount: 9000, period: '3_months', reference: 'SJK5ABCDE1' });
    assert.equal(r.status, 201);
    assert.equal(biz().web_access_expires_at, CP.addMonthsClamped(was, 3));
  });
  await ok('the plan is editable: 6 months at an amount the admin types (not hard-coded); a custom period needs its date', async () => {
    const r = await call('PUT', `/api/admin/clients/${B}/cloud-plan`, ADMIN, { period: '6_months', amount: '17,500' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.plan.period, r.body.plan.amount], ['6_months', 17500]);
    assert.equal((await call('PUT', `/api/admin/clients/${B}/cloud-plan`, ADMIN, { period: 'weekly', amount: 1 })).status, 400);
    const c = await pay(B, { amount: 5000, period: 'custom', reference: 'SJK6ABCDE2' });
    assert.equal(c.status, 400); assert.equal(c.body.code, 'CUSTOM_END_REQUIRED');
    const g = await call('GET', `/api/admin/clients/${B}/cloud-plan`, ADMIN);
    assert.deepEqual(g.body.defaults.periods.map((p) => p.amount), [3000, 9000, 18000, 36000, null]);
  });
  await ok('a lapsed trial: Record payment converts it and opens sync (a payment, not a fixed KES 10,000 year)', async () => {
    const r = await pay(T, { amount: 3000, period: 'monthly', reference: 'SJK7TRIAL1' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.trial_converted, true);
    assert.ok(mem.db.business_settings.find((s) => s.business_id === T).value.converted_at);
    assert.ok(mem.db.cloud_plans.find((p) => p.business_id === T), 'the first payment puts the client on the plan');
    assert.equal((await call('POST', '/api/orders', TILL_T, {})).status, 201);
  });

  console.log('\n4. The reminders\n');
  const run = (now = new Date()) => JOB.runCloudPlanReminders(now, { force: true });
  await ok('5 days before: one email to the owner AND one to ZapTill, with the amount, the period, the date and how to pay', async () => {
    reset(); setPaidUntil(Date.now() + 5 * DAY); mem.db.businesses = mem.db.businesses.filter((b) => b.id !== T);
    const out = await run();
    assert.deepEqual(out.sent.map((s) => [s.business_id, s.milestone, s.owner, s.admin]), [[B, 'before_7', true, true]]);
    const owner = mails.find((m) => m.to === 'owner@pollo.test'), admin = mails.find((m) => /billing@zaptill\.test/.test(m.to));
    assert.ok(owner && admin, `mails to ${mails.map((m) => m.to).join(', ')}`);
    assert.match(owner.subject, /5 days left/);
    assert.match(owner.html, /KES 3,000/); assert.match(owner.html, /month on month/); assert.match(owner.html, /0717 675 635/);
    assert.match(owner.html, new RegExp(EM.planDate(biz().web_access_expires_at)));
    assert.match(owner.html, /Pollo &lt;b&gt;Grill&lt;\/b&gt;/, 'the name escaped'); assert.doesNotMatch(owner.html, /<b>Grill<\/b>/);
    assert.match(admin.html, /Owner&#39;s copy: owner@pollo\.test|Owner's copy: owner@pollo\.test/);
    const rem = mem.db.cloud_plan_reminders[0];
    assert.deepEqual([rem.milestone, rem.owner_sent, rem.admin_sent, rem.owner_email], ['before_7', true, true, 'owner@pollo.test']);
  });
  await ok('idempotent: the next hour sends nothing for the same milestone', async () => {
    mails.length = 0;
    assert.equal((await run()).sent.length, 0); assert.equal(mails.length, 0);
  });
  await ok('the next milestone (2 days → 3 days before) goes; a payment (a new paid-until) starts afresh', async () => {
    setPaidUntil(Date.now() + 2 * DAY);
    assert.deepEqual((await run()).sent.map((s) => s.milestone), ['before_3']);
    setPaidUntil(Date.now() + 2 * DAY + 3600_000);
    assert.deepEqual((await run()).sent.map((s) => s.milestone), ['before_3'], 'a new paid-until is a new set');
  });
  await ok('the day it lapses, then weekly while lapsed (with "sync stopped" past the grace); none after 8 weeks', async () => {
    setPaidUntil(Date.now() - 3600_000);
    assert.deepEqual((await run()).sent.map((s) => s.milestone), ['lapse_day']);
    setPaidUntil(Date.now() - 23 * DAY);
    mails.length = 0;
    assert.deepEqual((await run()).sent.map((s) => s.milestone), ['lapsed_w3']);
    assert.match(mails.find((m) => m.to === 'owner@pollo.test').html, /stopped syncing your tills/);
    setPaidUntil(Date.now() - 70 * DAY);
    assert.equal((await run()).sent.length, 0);
  });
  await ok('only in the day (07:00–20:00 Nairobi) unless forced', async () => {
    assert.equal(CP.reminderHour(Date.parse('2026-10-23T03:30:00Z')), false);   // 06:30 EAT
    assert.equal(CP.reminderHour(Date.parse('2026-10-23T05:00:00Z')), true);    // 08:00 EAT
    assert.equal(CP.reminderHour(Date.parse('2026-10-23T17:30:00Z')), false);   // 20:30 EAT
  });
  await ok('no email provider: logged and skipped (no crash); the claim is kept, the failure recorded', async () => {
    reset(); setPaidUntil(Date.now() + DAY); mailOk = false;
    const out = await run();
    assert.equal(out.sent[0].milestone, 'before_1');
    const rem = mem.db.cloud_plan_reminders.find((r) => r.business_id === B);
    assert.equal(rem.owner_sent, false); assert.match(rem.error, /No email provider|not sent/);
  });
  await ok('a business not on the plan gets no reminder; a suspended one neither', async () => {
    reset(); setPaidUntil(Date.now() + 3 * DAY, L);
    biz(B).status = 'suspended'; setPaidUntil(Date.now() + 3 * DAY);
    const out = await run();
    assert.ok(!out.sent.some((s) => s.business_id === L || s.business_id === B));
  });
  await ok('the words: before (what happens after the grace), lapsed in grace, a trial', () => {
    const f = { businessName: 'Duka', milestone: 'before_14', daysLeft: 14, paidUntil: '2026-11-06T07:00:00Z', syncStopsAt: '2026-11-27T07:00:00Z',
      amount: 18000, currency: 'KES', period: '6_months', trial: false, syncStopped: false, ownerEmail: null };
    const w = EM.reminderWords(f);
    assert.match(w.headline, /paid until 6 Nov 2026 — 14 days left/); assert.match(w.lines[0], /until 27 Nov 2026/); assert.match(w.lines[1], /KES 18,000 for 6 months/);
    assert.match(EM.reminderWords({ ...f, daysLeft: -3 }).headline, /ended on 6 Nov 2026 — 3 days ago/);
    assert.match(EM.reminderWords({ ...f, trial: true, daysLeft: 3 }).headline, /cloud trial for Duka ends 6 Nov 2026/);
    assert.match(EM.reminderAdminText(f).text, /Owner's copy: no email on file/);
  });

  console.log('\n5. Shown\n');
  await ok('the owner\'s dashboard: GET /api/business/cloud-trial carries the plan; the notice in the last 14 days and while lapsed', async () => {
    reset(); setPaidUntil(Date.now() + 5 * DAY);
    const r = await call('GET', '/api/business/cloud-trial', OWNER_WEB);
    assert.equal(r.status, 200); assert.equal(r.body.plan.days_left, 5); assert.equal(r.body.plan.amount, 3000);
    assert.match(N.planNotice(r.body.plan), /paid until .* \(5 days left\)\. To renew: KES 3,000 a month — WhatsApp or call ZapTill on 0717 675 635/);
    assert.equal(N.planNotice({ ...r.body.plan, days_left: 15 }), null, 'not before the last 14 days');
    assert.match(N.planNotice({ ...r.body.plan, days_left: -25, sync_refused: true }), /stopped syncing them until it is paid/);
    assert.match(N.planNotice({ ...r.body.plan, days_left: -3, sync_stops_at: iso(Date.now() + 18 * DAY) }), /syncing stops on/);
    assert.equal(N.planNotice({ ...r.body.plan, trial: true }), null, 'a trial has its own notice');
  });
  await ok('the admin client list: "Expires in 5 days" / "Lapsed 3 days", and the Expiring / Lapsed filter', async () => {
    reset(); setPaidUntil(Date.now() + 5 * DAY);
    const all = await call('GET', '/api/admin/clients', ADMIN);
    const row = all.body.clients.find((c) => c.id === B);
    assert.equal(row.cloud.days_left, 5); assert.equal(P.expiryText(row.cloud).text, 'Expires in 5 days');
    assert.equal(all.body.clients.find((c) => c.id === L).cloud, null, 'not on the plan: no expiry shown');
    assert.equal(P.expiryText({ ...row.cloud, days_left: -3, sync_refused: false }).text, 'Lapsed 3 days');
    assert.equal(P.expiryText({ ...row.cloud, days_left: -25, sync_refused: true }).text, 'Lapsed 25 days — sync stopped');
    const exp = await call('GET', '/api/admin/clients?expiry=expiring', ADMIN);
    assert.deepEqual(exp.body.clients.map((c) => c.id), [B]);
    const lap = await call('GET', '/api/admin/clients?expiry=lapsed', ADMIN);
    assert.deepEqual(lap.body.clients.map((c) => c.id), [T], 'the lapsed trial only');
    const a = read('apps/admin/src/AdminPortal.tsx');
    assert.match(a, /data-testid="client-expiry-filter"/); assert.match(a, /data-testid="client-expiry"/);
  });
  await ok('the watchdog and the owner\'s alerts leave a lapsed business\'s tills out of "not syncing"', async () => {
    reset();
    const ids = await CP.lapsedBusinessIds();
    assert.deepEqual([...ids].sort(), [B, T].sort());
    assert.match(read('apps/server/src/jobs/watchdog.ts'), /filter\(\(d\) => !lapsed\.has\(d\.business_id\)\)/);
    assert.match(read('apps/server/src/jobs/ownerAlerts.ts'), /if \(planLapsed\) continue;/);
  });
  await ok('no cashier surface: the server words are only on the till\'s manager notice (syncNotice, canSeeSync) and the owner\'s', () => {
    const pos = read('apps/desktop/src/renderer/pages/POSPage.tsx');
    assert.match(pos, /const notice = canSeeSync \? syncNotice\(syncStatus\) : null;/);
    assert.doesNotMatch(pos, /CLOUD_SUBSCRIPTION_ENDED/);
  });
} finally {
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
